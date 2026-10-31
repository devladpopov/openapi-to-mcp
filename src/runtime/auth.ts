// Authentication for outgoing API requests. The mode is fixed at generation
// time (src/config.ts); credentials always come from environment variables.

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AuthConfig } from "./types.js";

export interface AuthTarget {
	headers: Record<string, string>;
	url: URL;
}

export async function applyAuth(auth: AuthConfig, target: AuthTarget): Promise<void> {
	switch (auth.mode) {
		case "none":
			return;
		case "api-key": {
			const key = requireEnv("API_KEY");
			const name = auth.apiKeyName ?? "X-API-Key";
			if (auth.apiKeyIn === "query") target.url.searchParams.set(name, key);
			else if (auth.apiKeyIn === "cookie") appendCookie(target.headers, `${name}=${encodeURIComponent(key)}`);
			else target.headers[name] = process.env.API_KEY_PREFIX ? `${process.env.API_KEY_PREFIX} ${key}` : key;
			return;
		}
		case "bearer":
			target.headers.Authorization = `Bearer ${requireEnv("API_TOKEN")}`;
			return;
		case "basic": {
			const user = process.env.API_USERNAME ?? "";
			const pass = process.env.API_PASSWORD ?? "";
			if (!user && !pass) throw new Error("API_USERNAME and API_PASSWORD environment variables are required");
			target.headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
			return;
		}
		case "oauth2":
			target.headers.Authorization = `Bearer ${await clientCredentialsToken(auth)}`;
			return;
		case "oauth2-auth-code":
			target.headers.Authorization = `Bearer ${await authCodeToken(auth)}`;
			return;
	}
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} environment variable is required`);
	return v;
}

function appendCookie(headers: Record<string, string>, cookie: string): void {
	headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${cookie}` : cookie;
}

// --- OAuth2 client credentials -------------------------------------------

let ccToken: { token: string; expiresAt: number } | null = null;

async function clientCredentialsToken(auth: AuthConfig): Promise<string> {
	if (ccToken && Date.now() < ccToken.expiresAt) return ccToken.token;
	const tokenUrl = process.env.OAUTH_TOKEN_URL ?? auth.tokenUrl;
	const clientId = process.env.OAUTH_CLIENT_ID;
	const clientSecret = process.env.OAUTH_CLIENT_SECRET;
	if (!tokenUrl || !clientId || !clientSecret) {
		throw new Error("OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, and OAUTH_CLIENT_SECRET are required");
	}
	const scopes = process.env.OAUTH_SCOPES ?? "";
	const res = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: clientId,
			client_secret: clientSecret,
			...(scopes ? { scope: scopes } : {}),
		}),
	});
	if (!res.ok) throw new Error(`OAuth token request failed: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as { access_token: string; expires_in?: number };
	ccToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 };
	return ccToken.token;
}

// --- OAuth2 authorization code + PKCE --------------------------------------

interface TokenStore {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}

let tokenStore: TokenStore | null = process.env.OAUTH_ACCESS_TOKEN
	? {
			accessToken: process.env.OAUTH_ACCESS_TOKEN,
			refreshToken: process.env.OAUTH_REFRESH_TOKEN,
			expiresAt: Date.now() + 50 * 60 * 1000,
		}
	: null;
let pendingAuthorization: Promise<string> | null = null;

function oauthSettings(auth: AuthConfig) {
	const port = Number.parseInt(process.env.OAUTH_REDIRECT_PORT ?? "8976", 10);
	return {
		authUrl: process.env.OAUTH_AUTH_URL ?? auth.authorizationUrl ?? "",
		tokenUrl: process.env.OAUTH_TOKEN_URL ?? auth.tokenUrl ?? "",
		clientId: process.env.OAUTH_CLIENT_ID ?? "",
		clientSecret: process.env.OAUTH_CLIENT_SECRET ?? "",
		scopes: process.env.OAUTH_SCOPES ?? auth.scopes ?? "",
		port,
		redirectUri: process.env.OAUTH_REDIRECT_URI ?? `http://localhost:${port}/callback`,
	};
}

async function authCodeToken(auth: AuthConfig): Promise<string> {
	if (tokenStore && Date.now() < tokenStore.expiresAt) return tokenStore.accessToken;
	if (tokenStore?.refreshToken) {
		try {
			return await refreshAccessToken(auth);
		} catch {
			// Refresh failed, fall through to interactive authorization.
		}
	}
	// Concurrent tool calls share one browser authorization.
	pendingAuthorization ??= authorizeInteractive(auth).finally(() => {
		pendingAuthorization = null;
	});
	return pendingAuthorization;
}

async function tokenRequest(tokenUrl: string, body: Record<string, string>): Promise<TokenStore> {
	const res = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(body),
	});
	if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
	};
}

async function refreshAccessToken(auth: AuthConfig): Promise<string> {
	const s = oauthSettings(auth);
	if (!tokenStore?.refreshToken) throw new Error("No refresh token available");
	try {
		const next = await tokenRequest(s.tokenUrl, {
			grant_type: "refresh_token",
			refresh_token: tokenStore.refreshToken,
			client_id: s.clientId,
			...(s.clientSecret ? { client_secret: s.clientSecret } : {}),
		});
		tokenStore = { ...next, refreshToken: next.refreshToken ?? tokenStore.refreshToken };
		return tokenStore.accessToken;
	} catch (err) {
		tokenStore = null;
		throw err;
	}
}

function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

async function authorizeInteractive(auth: AuthConfig): Promise<string> {
	const s = oauthSettings(auth);
	if (!s.clientId) throw new Error("OAUTH_CLIENT_ID is required");
	if (!s.authUrl || !s.tokenUrl) throw new Error("OAUTH_AUTH_URL and OAUTH_TOKEN_URL are required");

	const { verifier, challenge } = generatePKCE();
	const state = randomBytes(16).toString("hex");
	const authUrl = new URL(s.authUrl);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", s.clientId);
	authUrl.searchParams.set("redirect_uri", s.redirectUri);
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	if (s.scopes) authUrl.searchParams.set("scope", s.scopes);

	// stdout belongs to the MCP stdio transport, so talk to the user on stderr.
	console.error(`\nOpen this URL to authorize:\n${authUrl.toString()}\n`);

	const code = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => {
			srv.close();
			reject(new Error("OAuth callback timed out after 120 seconds"));
		}, 120_000);
		const srv = createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://localhost:${s.port}`);
			if (url.pathname !== "/callback") {
				res.writeHead(404);
				res.end();
				return;
			}
			const error = url.searchParams.get("error");
			const receivedCode = url.searchParams.get("code");
			const finish = (err?: Error) => {
				clearTimeout(timer);
				srv.close();
				if (err) reject(err);
				else resolve(receivedCode as string);
			};
			// Ignore requests that do not carry our state, so stray or hostile
			// requests cannot abort the flow.
			if (url.searchParams.get("state") !== state) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("Invalid callback");
				return;
			}
			if (error) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end(`Authorization error: ${error}`);
				return finish(new Error(`OAuth error: ${error}`));
			}
			if (!receivedCode) {
				res.writeHead(400, { "Content-Type": "text/plain" });
				res.end("Missing authorization code");
				return finish(new Error("Invalid OAuth callback"));
			}
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");
			finish();
		});
		srv.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		srv.listen(s.port, "127.0.0.1", () => console.error(`Waiting for OAuth callback on port ${s.port}...`));
	});

	tokenStore = await tokenRequest(s.tokenUrl, {
		grant_type: "authorization_code",
		code,
		redirect_uri: s.redirectUri,
		client_id: s.clientId,
		code_verifier: verifier,
		...(s.clientSecret ? { client_secret: s.clientSecret } : {}),
	});
	return tokenStore.accessToken;
}

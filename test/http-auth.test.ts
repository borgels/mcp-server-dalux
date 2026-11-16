import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config-env.js';
import {
  assertAllowedHost,
  assertAuthorized,
  AuthFailureLimiter,
  configWarnings,
  getHttpConfig,
  type HttpConfig,
  isLoopbackHost,
  isOriginAllowed,
  tokensEqual,
} from '../src/transports/http-helpers.js';

function req(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

const TOKEN = 'a'.repeat(32);
const base: HttpConfig = { host: '127.0.0.1', port: 0, maxBodyBytes: 1024 };

describe('http auth hardening', () => {
  it('compares tokens in constant time regardless of length', () => {
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcdef')).toBe(false);
  });

  it('accepts the configured bearer token and rejects others with WWW-Authenticate', () => {
    const config = { ...base, httpToken: TOKEN };
    expect(() => assertAuthorized(req({ authorization: `Bearer ${TOKEN}` }), config)).not.toThrow();
    expect(() => assertAuthorized(req({ authorization: 'Bearer wrong' }), config)).toThrow('Unauthorized');
    expect(() => assertAuthorized(req(), config)).toThrow(
      expect.objectContaining({ status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }),
    );
  });
});

describe('getHttpConfig', () => {
  it('defaults to loopback without a token', () => {
    const config = getHttpConfig({});
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3000, maxBodyBytes: 10_485_760 });
    expect(config.httpToken).toBeUndefined();
  });

  it('refuses a non-loopback host without a token', () => {
    expect(() => getHttpConfig({ HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => getHttpConfig({ MCP_HTTP_HOST: '::', MCP_HTTP_TOKEN: '' })).toThrow(/MCP_HTTP_TOKEN/);
    expect(getHttpConfig({ HOST: '0.0.0.0', MCP_HTTP_TOKEN: TOKEN }).httpToken).toBe(TOKEN);
  });

  it('refuses MCP_ALLOW_ANY_ORIGIN=true without a token', () => {
    expect(() => getHttpConfig({ MCP_ALLOW_ANY_ORIGIN: 'true' })).toThrow(/MCP_ALLOW_ANY_ORIGIN/);
    expect(getHttpConfig({ MCP_ALLOW_ANY_ORIGIN: 'true', MCP_HTTP_TOKEN: TOKEN }).allowAnyOrigin).toBe(true);
  });

  it('allows the explicit escape hatch with a warning', () => {
    const config = getHttpConfig({ HOST: '0.0.0.0', MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true' });
    expect(config.allowUnauthenticated).toBe(true);
    expect(configWarnings(config)).toHaveLength(1);
    expect(configWarnings(getHttpConfig({}))).toEqual([]);
  });

  it('requires a token of at least 32 characters', () => {
    expect(() => getHttpConfig({ MCP_HTTP_TOKEN: 'short' })).toThrow(/at least 32/);
    expect(() =>
      getHttpConfig({ MCP_HTTP_TOKEN: 'short', MCP_HTTP_ALLOW_UNAUTHENTICATED: 'true' }),
    ).toThrow(/at least 32/);
  });

  it('rejects invalid numeric values instead of producing NaN', () => {
    expect(() => getHttpConfig({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => getHttpConfig({ PORT: '0' })).toThrow(/PORT/);
    expect(() => getHttpConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => getHttpConfig({ MCP_MAX_BODY_BYTES: '10mb' })).toThrow(/MCP_MAX_BODY_BYTES/);
    expect(() => getHttpConfig({ MCP_MAX_BODY_BYTES: '-1' })).toThrow(/MCP_MAX_BODY_BYTES/);
    expect(() => getHttpConfig({ MCP_ALLOW_ANY_ORIGIN: 'maybe' })).toThrow(/MCP_ALLOW_ANY_ORIGIN/);
    expect(getHttpConfig({ PORT: '8080', MCP_MAX_BODY_BYTES: '2048' })).toMatchObject({
      port: 8080,
      maxBodyBytes: 2048,
    });
  });
});

describe('host and origin checks', () => {
  it('recognises loopback hosts', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('only accepts localhost Host headers on a loopback bind by default', () => {
    expect(() => assertAllowedHost(req({ host: 'localhost:3000' }), base)).not.toThrow();
    expect(() => assertAllowedHost(req({ host: '[::1]:3000' }), base)).not.toThrow();
    expect(() => assertAllowedHost(req({ host: 'attacker.example' }), base)).toThrow('Host not allowed');
    expect(() => assertAllowedHost(req(), base)).toThrow('Host not allowed');
  });

  it('uses MCP_ALLOWED_HOSTS when configured and skips the check otherwise on public binds', () => {
    const publicBind = { ...base, host: '0.0.0.0' };
    expect(() => assertAllowedHost(req({ host: 'anything.example' }), publicBind)).not.toThrow();
    const restricted = { ...publicBind, allowedHosts: ['mcp.example.com'] };
    expect(() => assertAllowedHost(req({ host: 'MCP.example.com:443' }), restricted)).not.toThrow();
    expect(() => assertAllowedHost(req({ host: 'other.example.com' }), restricted)).toThrow('Host not allowed');
  });

  it('allows localhost origins by default and configured origins otherwise', () => {
    expect(isOriginAllowed(undefined, {})).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', {})).toBe(true);
    expect(isOriginAllowed('http://[::1]:5173', {})).toBe(true);
    expect(isOriginAllowed('https://evil.example', {})).toBe(false);
    expect(isOriginAllowed('https://app.example', { allowedOrigins: ['https://app.example'] })).toBe(true);
    expect(isOriginAllowed('http://localhost:5173', { allowedOrigins: ['https://app.example'] })).toBe(false);
  });
});

describe('AuthFailureLimiter', () => {
  it('blocks a key after the limit until the window ends', () => {
    const limiter = new AuthFailureLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfterSeconds('a', 0)).toBe(0);
      limiter.recordFailure('a', 0);
    }
    expect(limiter.retryAfterSeconds('a', 1_000)).toBe(59);
    expect(limiter.retryAfterSeconds('b', 1_000)).toBe(0);
    expect(limiter.retryAfterSeconds('a', 60_000)).toBe(0);
  });

  it('keeps memory bounded', () => {
    const limiter = new AuthFailureLimiter(3, 60_000, 100);
    for (let i = 0; i < 1_000; i++) {
      limiter.recordFailure(`key-${i}`, 0);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

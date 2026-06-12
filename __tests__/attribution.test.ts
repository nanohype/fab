import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  resolveSessionIdentity,
  sanitizeForSts,
  assumeWithSourceIdentity,
  writeImpersonationKubeconfig,
  applySessionIdentity,
  type CliRunner,
  type SessionIdentity,
} from '../src/attribution.js';

const ROLE = 'arn:aws:iam::351619759866:role/fab-session';

/** A CliRunner that returns canned assume-role creds and records its args. */
function fakeRunner(calls: string[][]): CliRunner {
  return async (_file, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify({
        Credentials: {
          AccessKeyId: 'AKIAFAKE',
          SecretAccessKey: 'secret',
          SessionToken: 'token',
          Expiration: '2026-06-11T12:00:00Z',
        },
      }),
    };
  };
}

describe('resolveSessionIdentity', () => {
  it('returns null when no operator is set (unattributed default)', () => {
    expect(resolveSessionIdentity({})).toBeNull();
  });

  it('throws when an operator is set but no session role', () => {
    expect(() => resolveSessionIdentity({ FAB_OPERATOR: 'alice@acme.com' })).toThrow(/FAB_SESSION_ROLE_ARN/);
  });

  it('resolves operator + role with the default duration', () => {
    expect(resolveSessionIdentity({ FAB_OPERATOR: 'alice@acme.com', FAB_SESSION_ROLE_ARN: ROLE })).toEqual({
      operator: 'alice@acme.com',
      roleArn: ROLE,
      durationSeconds: 3600,
    });
  });

  it('honors a custom in-range duration', () => {
    const id = resolveSessionIdentity({
      FAB_OPERATOR: 'alice@acme.com',
      FAB_SESSION_ROLE_ARN: ROLE,
      FAB_SESSION_DURATION: '7200',
    });
    expect(id?.durationSeconds).toBe(7200);
  });

  it('rejects an out-of-range duration', () => {
    expect(() =>
      resolveSessionIdentity({
        FAB_OPERATOR: 'alice@acme.com',
        FAB_SESSION_ROLE_ARN: ROLE,
        FAB_SESSION_DURATION: '60',
      }),
    ).toThrow(/900–43200/);
  });

  it('rejects an operator that is not STS-clean (so AWS == K8s binding)', () => {
    expect(() => resolveSessionIdentity({ FAB_OPERATOR: 'alice smith', FAB_SESSION_ROLE_ARN: ROLE })).toThrow(
      /A-Za-z0-9/,
    );
    expect(() => resolveSessionIdentity({ FAB_OPERATOR: 'x', FAB_SESSION_ROLE_ARN: ROLE })).toThrow(/2–64/);
  });
});

describe('sanitizeForSts', () => {
  it('passes an email through (already STS-valid)', () => {
    expect(sanitizeForSts('alice@acme.com', 'fallback')).toBe('alice@acme.com');
  });
  it('replaces disallowed characters and trims edge dashes', () => {
    expect(sanitizeForSts('a b/c:d', 'fallback')).toBe('a-b-c-d');
    expect(sanitizeForSts('//xy//', 'fallback')).toBe('xy');
  });
  it('bounds length to 64', () => {
    expect(sanitizeForSts('a'.repeat(200), 'fallback')).toHaveLength(64);
  });
  it('falls back when the value sanitizes to fewer than 2 chars', () => {
    expect(sanitizeForSts('///', 'fab-session')).toBe('fab-session');
    expect(sanitizeForSts('/a/', 'fab-session')).toBe('fab-session');
  });
});

describe('assumeWithSourceIdentity', () => {
  const id: SessionIdentity = { operator: 'alice@acme.com', roleArn: ROLE, durationSeconds: 3600 };

  it('calls aws sts assume-role with the operator as SourceIdentity and maps the creds', async () => {
    const calls: string[][] = [];
    const creds = await assumeWithSourceIdentity(id, 'fab-build', fakeRunner(calls));
    expect(creds).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIAFAKE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
    });
    const args = calls[0];
    expect(args.slice(0, 2)).toEqual(['sts', 'assume-role']);
    expect(args[args.indexOf('--source-identity') + 1]).toBe('alice@acme.com');
    expect(args[args.indexOf('--role-arn') + 1]).toBe(ROLE);
    expect(args[args.indexOf('--duration-seconds') + 1]).toBe('3600');
  });

  it('throws when STS returns no credentials', async () => {
    const empty: CliRunner = async () => ({ stdout: JSON.stringify({}) });
    await expect(assumeWithSourceIdentity(id, 'fab-build', empty)).rejects.toThrow(/no usable credentials/);
  });
});

describe('writeImpersonationKubeconfig', () => {
  it('writes a kubeconfig that impersonates the operator via the SA token', () => {
    const path = writeImpersonationKubeconfig('alice@acme.com');
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('as: "alice@acme.com"');
    expect(body).toContain('tokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token');
    expect(body).toContain('server: https://kubernetes.default.svc');
  });
});

describe('applySessionIdentity', () => {
  it('returns null and touches nothing when unattributed', async () => {
    const env: NodeJS.ProcessEnv = {};
    const id = await applySessionIdentity('fab-build', env, fakeRunner([]));
    expect(id).toBeNull();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
  });

  it('exports SourceIdentity creds and a kubeconfig when an operator is set', async () => {
    const env: NodeJS.ProcessEnv = { FAB_OPERATOR: 'alice@acme.com', FAB_SESSION_ROLE_ARN: ROLE };
    const id = await applySessionIdentity('fab-build', env, fakeRunner([]));
    expect(id?.operator).toBe('alice@acme.com');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAFAKE');
    expect(env.AWS_SESSION_TOKEN).toBe('token');
    expect(env.KUBECONFIG).toMatch(/config$/);
    expect(readFileSync(env.KUBECONFIG as string, 'utf8')).toContain('as: "alice@acme.com"');
  });

  it('drops the pod IRSA env so only the assumed creds remain', async () => {
    const env: NodeJS.ProcessEnv = {
      FAB_OPERATOR: 'alice@acme.com',
      FAB_SESSION_ROLE_ARN: ROLE,
      AWS_ROLE_ARN: 'arn:aws:iam::1:role/tenant',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/eks.amazonaws.com/serviceaccount/token',
      AWS_ROLE_SESSION_NAME: 'botocore-session',
    };
    await applySessionIdentity('fab-build', env, fakeRunner([]));
    expect(env.AWS_ROLE_ARN).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
    expect(env.AWS_ROLE_SESSION_NAME).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAFAKE');
  });
});

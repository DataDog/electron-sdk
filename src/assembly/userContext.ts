import { SKIPPED, type RecursivePartial } from '@datadog/browser-core';
import type { RumEvent } from '../domain/rum';
import type { FormatHooks } from './hooks';

export interface UserInfo {
  id: string;
  name?: string;
  email?: string;
  extraInfo?: Record<string, unknown>;
}

export interface AccountInfo {
  id: string;
  name?: string;
  extraInfo?: Record<string, unknown>;
}

const USER_STANDARD_KEYS = new Set(['id', 'name', 'email']);
const ACCOUNT_STANDARD_KEYS = new Set(['id', 'name']);

/**
 * Stores user and account information and injects it into RUM events via format hooks.
 */
export class UserContext {
  private user: UserInfo | undefined;
  private account: AccountInfo | undefined;

  constructor(hooks: FormatHooks) {
    hooks.registerRum(() => {
      if (!this.user && !this.account) return SKIPPED;

      const usr = this.user ? spreadInfo(this.user) : undefined;
      const account = this.account ? spreadInfo(this.account) : undefined;

      return {
        ...(usr !== undefined && { usr }),
        ...(account !== undefined && { account }),
      } as RecursivePartial<RumEvent>;
    });
  }

  setUserInfo(user: UserInfo): void {
    const { extraInfo, ...rest } = user;
    this.user = extraInfo ? { ...rest, extraInfo: { ...extraInfo } } : { ...rest };
  }

  getUserInfo(): UserInfo | undefined {
    if (!this.user) return undefined;
    const { extraInfo, ...rest } = this.user;
    return extraInfo ? { ...rest, extraInfo: { ...extraInfo } } : { ...rest };
  }

  clearUserInfo(): void {
    this.user = undefined;
  }

  setUserInfoProperty(key: string, value: unknown): void {
    if (!this.user || key === 'id') return;
    if (USER_STANDARD_KEYS.has(key)) {
      this.user = { ...this.user, [key]: value };
    } else {
      this.user = { ...this.user, extraInfo: { ...this.user.extraInfo, [key]: value } };
    }
  }

  removeUserInfoProperty(key: string): void {
    if (!this.user || key === 'id') return;
    if (USER_STANDARD_KEYS.has(key)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = this.user as unknown as Record<string, unknown>;
      this.user = rest as unknown as UserInfo;
    } else if (this.user.extraInfo) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = this.user.extraInfo;
      this.user = { ...this.user, extraInfo: Object.keys(rest).length > 0 ? rest : undefined };
    }
  }

  setAccountInfo(accountInfo: AccountInfo): void {
    const { extraInfo, ...rest } = accountInfo;
    this.account = extraInfo ? { ...rest, extraInfo: { ...extraInfo } } : { ...rest };
  }

  getAccountInfo(): AccountInfo | undefined {
    if (!this.account) return undefined;
    const { extraInfo, ...rest } = this.account;
    return extraInfo ? { ...rest, extraInfo: { ...extraInfo } } : { ...rest };
  }

  clearAccountInfo(): void {
    this.account = undefined;
  }

  setAccountInfoProperty(key: string, value: unknown): void {
    if (!this.account || key === 'id') return;
    if (ACCOUNT_STANDARD_KEYS.has(key)) {
      this.account = { ...this.account, [key]: value };
    } else {
      this.account = { ...this.account, extraInfo: { ...this.account.extraInfo, [key]: value } };
    }
  }

  removeAccountInfoProperty(key: string): void {
    if (!this.account || key === 'id') return;
    if (ACCOUNT_STANDARD_KEYS.has(key)) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = this.account as unknown as Record<string, unknown>;
      this.account = rest as unknown as AccountInfo;
    } else if (this.account.extraInfo) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...rest } = this.account.extraInfo;
      this.account = { ...this.account, extraInfo: Object.keys(rest).length > 0 ? rest : undefined };
    }
  }
}

function spreadInfo({ extraInfo, ...standardFields }: UserInfo | AccountInfo): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(standardFields)) {
    if (v !== undefined) result[k] = v;
  }
  return { ...result, ...extraInfo };
}

// Created by DDD Presenter as a starting point. This file is yours to edit.

import type { Extensions } from "../../generated/cleaning-staff/application/ports.js";
import type { EmailAddress } from "../../generated/cleaning-staff/domain/value-objects.js";

/** Implementation of the CleaningStaff extension points (customer-owned). */
export class CleaningStaffExtensions implements Extensions {
  readonly #blockedDomains: ReadonlySet<string>;

  constructor(blockedDomains: Iterable<string> = []) {
    this.#blockedDomains = new Set(blockedDomains);
  }

  /** 配信停止・ブロック済みのメールアドレスか */
  isBlockedEmail(email: EmailAddress): boolean {
    return this.#blockedDomains.has(email.value.slice(email.value.lastIndexOf("@") + 1));
  }
}

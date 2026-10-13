/**
 * Names of the model's protobuf contract, shared by the .proto writer (`ddd migrate --split`, `generated/proto/`)
 * and the generated Connect handler, so both always agree (docs/10 §12, docs/09 §25).
 */
import type { ContextIR, UseCaseIR } from "../ir.ts";
import type { QueryIR } from "../queries.ts";
import { pascal, toSnake } from "../validate.ts";

/** `cleaning_staff.v1` */
export const protoPackage = (ctx: Pick<ContextIR, "name">) => `${toSnake(ctx.name)}.v1`;
/** `CleaningStaffService` */
export const protoService = (ctx: Pick<ContextIR, "name">) => `${ctx.name}Service`;
/** The rpc of a use case is its command. */
export const useCaseRpc = (u: Pick<UseCaseIR, "command">) => u.command;
export const queryRpc = (q: Pick<QueryIR, "name">) => pascal(q.name);
/** `/cleaning_staff.v1.CleaningStaffService/IssueInvitation` (the Connect / gRPC procedure path). */
export const procedurePath = (ctx: Pick<ContextIR, "name">, rpc: string) => `/${protoPackage(ctx)}.${protoService(ctx)}/${rpc}`;
/** `INVITATION_STATUS_` */
export const enumPrefix = (enumName: string) => toSnake(enumName).toUpperCase() + "_";
/** `INVITATION_STATUS_PENDING` */
export const enumValueName = (enumName: string, value: string) => enumPrefix(enumName) + toSnake(value).toUpperCase();

/** protoc's JSON name of a field: underscores dropped, the next character upper-cased (`valid_until` → `validUntil`). */
export function protoJsonName(field: string): string {
  let out = "";
  let upper = false;
  for (const c of field) {
    if (c === "_") upper = true;
    else {
      out += upper ? c.toUpperCase() : c;
      upper = false;
    }
  }
  return out;
}

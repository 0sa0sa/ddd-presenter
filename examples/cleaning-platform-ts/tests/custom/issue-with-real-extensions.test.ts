// Hand-written test: wires the generated use case with the customer-owned extension.

import { describe, expect, test } from "vitest";

import { CleaningStaffExtensions } from "../../src/cleaning_platform/extensions/cleaning-staff/extensions.js";
import { IssueInvitationUseCase } from "../../src/cleaning_platform/generated/cleaning-staff/application/use-cases.js";
import { IssueInvitation } from "../../src/cleaning_platform/generated/cleaning-staff/domain/commands.js";
import { EmailBlocked } from "../../src/cleaning_platform/generated/cleaning-staff/domain/errors.js";
import {
  CapturingEventPublisher,
  expectRejects,
  FakeUnitOfWork,
  FixedClock,
  InMemoryCleaningStaffInvitationRepository,
  SequentialIds,
} from "../../src/cleaning_platform/generated/cleaning-staff/testing.js";

function makeUseCase(blocked: string[]) {
  const unitOfWork = new FakeUnitOfWork();
  const eventPublisher = new CapturingEventPublisher();
  const useCase = new IssueInvitationUseCase({
    cleaningStaffInvitationRepository: new InMemoryCleaningStaffInvitationRepository(unitOfWork),
    clock: new FixedClock("2026-01-01T10:00:00+00:00"),
    ids: new SequentialIds(["00000000-0000-0000-0000-000000000001"]),
    extensions: new CleaningStaffExtensions(blocked),
    eventPublisher,
    unitOfWork,
  });
  return { useCase, eventPublisher, unitOfWork };
}

describe("issue_invitation with the real extensions", () => {
  test("a blocked domain is rejected and nothing is published", async () => {
    const { useCase, eventPublisher, unitOfWork } = makeUseCase(["spam.example"]);
    const command = IssueInvitation.create({ email: { value: "someone@spam.example" }, validUntil: "2026-01-08T10:00:00+00:00" });
    await expectRejects(() => useCase.execute(command), EmailBlocked);
    expect(unitOfWork.rolledBack).toBe(true);
    expect(eventPublisher.published).toEqual([]);
  });

  test("other domains are accepted", async () => {
    const { useCase, eventPublisher } = makeUseCase(["spam.example"]);
    const command = IssueInvitation.create({ email: { value: " Someone@Example.com " }, validUntil: "2026-01-08T10:00:00+00:00" });
    expect(await useCase.execute(command)).toBe("00000000-0000-0000-0000-000000000001");
    expect(eventPublisher.published.map((event) => event.type)).toEqual(["CleaningStaff.InvitationIssued"]);
  });
});

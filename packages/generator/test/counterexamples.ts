import { applyEdits, proofScenario, validateModelText } from "@ddd/core";
import { verifyModel } from "@ddd/verify";

/**
 * The model with every Z3 counterexample (docs/09 §29) added as an aggregate scenario that expects the rejection:
 * the generated code must raise exactly the error the proof predicted (the encoding and the generator agree).
 */
export async function withCounterexamples(source: string): Promise<{ text: string; added: number }> {
  let text = source;
  let added = 0;
  const report = await verifyModel(validateModelText(text).analysis!, { traceDepth: 0 });
  for (const r of report.results) {
    const sc = proofScenario(validateModelText(text).model!, r);
    if (!sc) continue;
    const e = applyEdits(text, [{ op: "add", path: sc.path, value: sc.value }]);
    if (!e.ok || !validateModelText(e.text).ok) throw new Error(`counterexample ${r.id} is not a valid scenario`);
    text = e.text;
    added++;
  }
  return { text, added };
}

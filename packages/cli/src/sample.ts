// The sample models shipped with `ddd init` are the same files used by the golden tests.
import sample from "../../../examples/cleaning-platform/model.ddd.yaml" with { type: "text" };
import sampleTs from "../../../examples/cleaning-platform-ts/model.ddd.yaml" with { type: "text" };

export const SAMPLE_MODEL: string = sample;
/** `ddd init --target typescript`: the same domain with `generation.target: typescript`. */
export const SAMPLE_MODEL_TS: string = sampleTs;

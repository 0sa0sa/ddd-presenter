import sample from "../../../examples/cleaning-platform/model.ddd.yaml" with { type: "text" };

/** Starting point for a new project (FR-001: empty projects show a sample model). */
export function sampleModel(): string {
  return sample;
}

export function emptyModel(project: string): string {
  const slug = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const pkg = slug.replace(/-/g, "_");
  return `schema_version: 1
project: ${slug}
generation:
  package: ${/^[a-z_]/.test(pkg) ? pkg : `p_${pkg}`}

contexts:
  - name: Core
    description: ""
    errors: []
    aggregates: []
    use_cases: []
`;
}

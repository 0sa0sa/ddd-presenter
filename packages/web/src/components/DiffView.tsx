export function DiffView({ diff }: { diff: string }) {
  if (!diff) return <p className="muted" style={{ padding: 16 }}>差分はありません。</p>;
  return (
    <pre className="code" aria-label="差分">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("@@") ? "diff-line-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "diff-line-add" : line.startsWith("-") && !line.startsWith("---") ? "diff-line-del" : undefined;
        return (
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

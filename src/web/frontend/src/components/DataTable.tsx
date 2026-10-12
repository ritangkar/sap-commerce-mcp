import { useMemo, useState } from "react";
import { CopyButton, Empty } from "./common";

export interface Column {
  key: string;
  label: string;
}

type Row = Record<string, unknown>;

const text = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function toCsv(columns: Column[], rows: Row[]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.map((c) => esc(c.label)).join(","), ...rows.map((r) => columns.map((c) => esc(text(r[c.key]))).join(","))].join("\n");
}

export function DataTable({
  columns,
  rows,
  caption,
  pageSize = 25,
  filterPlaceholder = "Filter rows…",
  onRowClick,
  emptyTitle = "No rows"
}: {
  columns: Column[];
  rows: Row[];
  caption: string;
  pageSize?: number;
  filterPlaceholder?: string;
  onRowClick?: (row: Row) => void;
  emptyTitle?: string;
}) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);

  const view = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let out = needle ? rows.filter((r) => columns.some((c) => text(r[c.key]).toLowerCase().includes(needle))) : rows;
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => text(a[sort.key]).localeCompare(text(b[sort.key]), undefined, { numeric: true }) * dir);
    }
    return out;
  }, [rows, columns, filter, sort]);

  const pages = Math.max(1, Math.ceil(view.length / pageSize));
  const current = Math.min(page, pages - 1);
  const slice = view.slice(current * pageSize, (current + 1) * pageSize);

  const toggle = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? (s.dir === "asc" ? { key, dir: "desc" } : null) : { key, dir: "asc" }));
  };

  return (
    <div className="table-block">
      <div className="table-toolbar">
        <input
          type="search"
          aria-label={`Filter ${caption}`}
          placeholder={filterPlaceholder}
          value={filter}
          onChange={(e) => { setFilter(e.target.value); setPage(0); }}
        />
        <span className="muted" aria-live="polite">
          {view.length === rows.length ? `${rows.length} row${rows.length === 1 ? "" : "s"}` : `${view.length} of ${rows.length} rows`}
        </span>
        <span className="spacer" />
        <CopyButton label="Copy CSV" text={() => toCsv(columns, view)} disabled={view.length === 0} />
        <CopyButton label="Copy JSON" text={() => JSON.stringify(view, null, 2)} disabled={view.length === 0} />
      </div>
      {rows.length === 0 ? (
        <Empty title={emptyTitle} />
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label={`${caption} (scrollable)`}>
          <table>
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} scope="col" aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" className="th-btn" onClick={() => toggle(c.key)}>
                      {c.label}
                      <span aria-hidden="true" className="sort-ind">{sort?.key === c.key ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {slice.map((r, i) => (
                <tr
                  key={i}
                  className={onRowClick ? "clickable" : undefined}
                  onClick={onRowClick ? () => onRowClick(r) : undefined}
                  onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(r); } : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {columns.map((c) => {
                    const v = text(r[c.key]);
                    return <td key={c.key} className={v === "****" ? "masked" : undefined} title={v.length > 60 ? v : undefined}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <nav className="pager" aria-label={`${caption} pages`}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage(current - 1)} disabled={current === 0}>Previous</button>
          <span className="muted">Page {current + 1} of {pages}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPage(current + 1)} disabled={current >= pages - 1}>Next</button>
        </nav>
      )}
    </div>
  );
}

import { Cross2Icon } from "@radix-ui/react-icons";
import { Badge, Heading, IconButton } from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ToolView } from "../model.js";
import { Data, Metadata } from "./components.js";
import { NavigationTabs } from "./navigation-tabs.js";
import { PaneDrawer, useNarrow } from "./panes.js";
import { boundedSearch, searchNeedle } from "./search.js";
import { ParameterSchema } from "./tool-inspector.js";
import {
  type InventoryGrouping,
  type InventoryRow,
  inventoryGroups,
  inventoryRows,
  type ToolColumn,
  toolCell,
  toolColumns,
} from "./tool-inventory.js";
import "./tool-explorer.css";

const eligibility =
  "Eligibility through Pi's nested-tool API, used by codemode. Runner availability, permission and execution success are not verified. This is not observed usage.";
const detailTabs = [
  { value: "overview", label: "Overview" },
  { value: "parameters", label: "Parameters" },
  { value: "source", label: "Source" },
] as const;

function ToolDetails({ tool }: { tool: ToolView }) {
  const [tab, setTab] = useState<(typeof detailTabs)[number]["value"]>("overview");
  return (
    <div className="tool-detail-content">
      <Heading size="3">{tool.name}</Heading>
      <div className="tool-badges">
        <Badge highContrast color="gray">
          {tool.exposure}
        </Badge>
        <Badge highContrast color={tool.callable ? "blue" : "gray"}>
          {tool.callable ? "Codemode eligible" : "Not eligible"}
        </Badge>
        <Badge highContrast color={tool.active ? "green" : "gray"}>
          {tool.active ? "Active" : "Inactive"}
        </Badge>
      </div>
      {tool.metadataTruncated && <p role="status">Tool metadata truncated.</p>}
      <NavigationTabs
        id="tool-detail"
        label="Tool detail sections"
        tabs={detailTabs}
        value={tab}
        change={(value) => setTab(value as typeof tab)}
      />
      <section key={tab} role="tabpanel" id={`tool-detail-panel-${tab}`} aria-labelledby={`tool-detail-tab-${tab}`}>
        {tab === "overview" && (
          <>
            <p className="inventory-description">{tool.description || "Description unavailable."}</p>
            <Metadata
              rows={[
                ["Exposure", tool.exposure],
                ["Codemode eligibility", tool.callable ? "Eligible" : "No"],
                ["Codemode runner", "Not verified"],
                ["Active", tool.active ? "Yes" : "No"],
                ["Source", tool.sourceGroup?.label ?? "Unknown source"],
                ["Namespace", tool.namespace],
              ]}
            />
            <p className="tool-note">{eligibility}</p>
          </>
        )}
        {tab === "parameters" && (
          <>
            {tool.schema.truncated && (
              <p role="status">Captured schema truncated; parameter documentation may be partial.</p>
            )}
            <ParameterSchema value={tool.schema.value} />
          </>
        )}
        {(tab === "overview" || tab === "source") && (
          <Data key="source" label={`Source · ${tool.name}`} data={tool.source} defaultOpen={tab === "source"} />
        )}
        {tab !== "source" && (
          <Data key="schema" label={`Schema · ${tool.name}`} data={tool.schema} defaultOpen={false} />
        )}
      </section>
    </div>
  );
}

function SourceNavigation({
  rows,
  grouping,
  selected,
  change,
}: {
  rows: InventoryRow[];
  grouping: InventoryGrouping;
  selected: string;
  change(id: string): void;
}) {
  const groups = inventoryGroups(rows);
  const categories =
    grouping === "exposure"
      ? [{ label: "Exposure", kinds: ["unknown"] }]
      : [
          { label: "Built-in", kinds: ["builtin"] },
          { label: "Namespaces / MCP", kinds: ["namespace"] },
          { label: "Extensions / Packages", kinds: ["extension", "package"] },
          { label: "Unknown", kinds: ["unknown"] },
        ];
  return (
    <nav className="tool-sources" aria-label="Tool sources">
      <Heading size="2">{grouping === "exposure" ? "Exposure groups" : "Sources"}</Heading>
      <button type="button" className="tool-source" aria-pressed={selected === "all"} onClick={() => change("all")}>
        <span>All tools</span>
        <span className="tool-count">{rows.length}</span>
      </button>
      {categories.map(({ label, kinds }) => {
        const entries = groups.filter(({ group }) => kinds.includes(group.kind));
        if (!entries.length) return null;
        return (
          <details key={label} open className="tool-source-category">
            <summary>
              {label}
              <span className="tool-count">{entries.reduce((sum, entry) => sum + entry.count, 0)}</span>
            </summary>
            {entries.map(({ group, count }) => (
              <button
                type="button"
                className="tool-source"
                key={group.id}
                title={`${group.label}${group.truncated ? " · truncated" : ""}`}
                aria-pressed={selected === group.id}
                onClick={() => change(group.id)}
              >
                <span>
                  {group.label}
                  {group.truncated && " · truncated"}
                </span>
                <span className="tool-count">{count}</span>
              </button>
            ))}
          </details>
        );
      })}
      <p className="tool-note">Namespace metadata does not verify MCP ownership or connection health.</p>
    </nav>
  );
}

export function ToolExplorer({ tools, active }: { tools: ToolView[]; active: boolean }) {
  const narrow = useNarrow();
  const [grouping, setGrouping] = useState<InventoryGrouping>("namespace");
  const [source, setSource] = useState("all");
  const [query, setQuery] = useState("");
  const [exposure, setExposure] = useState("all");
  const [columns, setColumns] = useState<ReadonlySet<ToolColumn>>(() => new Set(["exposure", "codemode", "active"]));
  const [selected, setSelected] = useState<string>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLButtonElement>(null);
  const columnsMenu = useRef<HTMLDetailsElement>(null);
  const rows = useMemo(() => inventoryRows(tools, grouping), [tools, grouping]);
  const groups = useMemo(() => inventoryGroups(rows), [rows]);
  const selectedSource = groups.find(({ group }) => group.id === source)?.group;
  // A disappearing source returns to All; a disappearing tool never selects a replacement by position.
  const effectiveSource = selectedSource ? source : "all";
  const current = rows.find((row) => row.id === selected);
  useEffect(() => {
    if (source !== "all" && !selectedSource) setSource("all");
    if (selected && !current) {
      setSelected(undefined);
      setDetailsOpen(false);
      if (active) searchInput.current?.focus({ preventScroll: true });
    }
    if (exposure !== "all" && !tools.some((tool) => tool.exposure === exposure)) setExposure("all");
  }, [source, selectedSource, selected, current, active, exposure, tools]);
  useEffect(() => {
    if (!narrow) setSourcesOpen(false);
    if (!active) {
      setSourcesOpen(false);
      if (narrow) setDetailsOpen(false);
      if (columnsMenu.current) columnsMenu.current.open = false;
    }
  }, [active, narrow]);
  const needle = searchNeedle(query);
  const visible = rows.filter(
    ({ tool, group }) =>
      (effectiveSource === "all" || group.id === effectiveSource) &&
      (exposure === "all" || tool.exposure === exposure) &&
      [tool.name, tool.description, tool.namespace, tool.sourceGroup?.label].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
  );
  function selectSource(id: string) {
    setSource(id);
    setSourcesOpen(false);
  }
  function closeDetails() {
    setDetailsOpen(false);
    if (detailTrigger.current?.isConnected) detailTrigger.current.focus({ preventScroll: true });
  }
  const sources = <SourceNavigation rows={rows} grouping={grouping} selected={effectiveSource} change={selectSource} />;
  const details = current && <ToolDetails key={current.id} tool={current.tool} />;
  return (
    <div className={`tool-explorer ${detailsOpen && current && !narrow ? "with-details" : ""}`}>
      <p className="tool-inventory-note">
        Current active ≠ provider-visible. Codemode shows nested-call eligibility, not observed usage.
      </p>
      <div className="tool-explorer-layout">
        {!narrow && <aside className="tool-source-pane">{sources}</aside>}
        <section className="tool-table-pane" aria-label="Tool inventory">
          <div className="tool-toolbar">
            <div className="tool-breadcrumb">
              <strong>{selectedSource?.label ?? "All tools"}</strong>
              <span>
                {visible.length} / {tools.length} tools
              </span>
            </div>
            <div className="tool-toolbar-controls">
              {narrow && (
                <button type="button" ref={sourceTrigger} onClick={() => setSourcesOpen(true)}>
                  Sources
                </button>
              )}
              <input
                ref={searchInput}
                type="search"
                aria-label="Search tools"
                placeholder="Search tools…"
                value={query}
                onChange={(event) => setQuery(boundedSearch(event.target.value))}
              />
              <label>
                Group by
                <select
                  aria-label="Group tools by"
                  value={grouping}
                  onChange={(event) => {
                    setGrouping(event.target.value as InventoryGrouping);
                    setSource("all");
                  }}
                >
                  <option value="namespace">Namespace / source</option>
                  <option value="source">Extension / package</option>
                  <option value="exposure">Exposure</option>
                </select>
              </label>
              <label>
                Exposure
                <select
                  aria-label="Filter tool exposure"
                  value={exposure}
                  onChange={(event) => setExposure(event.target.value)}
                >
                  <option value="all">All</option>
                  {[...new Set(tools.map((tool) => tool.exposure))].sort().map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <details
                className="tool-columns-menu"
                ref={columnsMenu}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (columnsMenu.current) {
                      columnsMenu.current.open = false;
                      columnsMenu.current.querySelector("summary")?.focus();
                    }
                  }
                }}
              >
                <summary>Columns</summary>
                <fieldset>
                  <legend>Visible columns</legend>
                  <label>
                    <input type="checkbox" checked disabled />
                    Name (required)
                  </label>
                  {toolColumns.map(({ id, label }) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={columns.has(id)}
                        onChange={() =>
                          setColumns((old) => {
                            const next = new Set(old);
                            if (next.has(id)) next.delete(id);
                            else next.add(id);
                            return next;
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </details>
              {current && !detailsOpen && (
                <button type="button" onClick={() => setDetailsOpen(true)}>
                  Show tool details
                </button>
              )}
            </div>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded table region needs keyboard focus for native horizontal and vertical scrolling. */}
          <section className="tool-table-scroll" tabIndex={0} aria-label="Scrollable tools table">
            <table className="tool-inventory-table">
              <caption className="sr-only">Current tools. Select a name to inspect its metadata.</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  {toolColumns
                    .filter(({ id }) => columns.has(id))
                    .map(({ id, label }) => (
                      <th scope="col" key={id} title={id === "codemode" ? eligibility : undefined}>
                        {label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(({ id, tool }) => (
                  <tr key={id} data-selected={selected === id || undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        aria-label={`Inspect ${tool.name}`}
                        aria-pressed={selected === id}
                        onClick={(event) => {
                          detailTrigger.current = event.currentTarget;
                          setSelected(id);
                          setDetailsOpen(true);
                        }}
                        title={tool.name}
                      >
                        {tool.name}
                      </button>
                    </th>
                    {toolColumns
                      .filter(({ id }) => columns.has(id))
                      .map(({ id: column }) => (
                        <td key={column} title={column === "codemode" ? eligibility : toolCell(tool, column)}>
                          <span className={`tool-cell-${column}`}>{toolCell(tool, column)}</span>
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!tools.length ? (
              <p className="tool-empty">No tools in this snapshot.</p>
            ) : (
              !visible.length && (
                <p className="tool-empty" role="status">
                  No tools match these filters.
                </p>
              )
            )}
          </section>
          <p className="tool-note tool-table-note">
            Codemode runner availability is not verified. Namespace/source metadata does not prove MCP server ownership.
          </p>
        </section>
        {!narrow && detailsOpen && current && (
          <aside className="tool-detail-pane" aria-label="Tool details">
            <div className="tool-panel-heading">
              <Heading size="2">Tool details</Heading>
              <IconButton variant="ghost" aria-label="Close tool details" onClick={closeDetails}>
                <Cross2Icon />
              </IconButton>
            </div>
            {details}
          </aside>
        )}
      </div>
      {narrow && (
        <>
          <PaneDrawer
            name="Tool sources"
            className="tool-resource-drawer"
            open={active && sourcesOpen}
            change={setSourcesOpen}
            side="left"
            trigger={sourceTrigger}
          >
            <div className="tool-explorer tool-drawer-body">{sources}</div>
          </PaneDrawer>
          <PaneDrawer
            name="Tool details"
            className="tool-resource-drawer"
            open={active && detailsOpen && Boolean(current)}
            change={setDetailsOpen}
            side="right"
            trigger={detailTrigger}
          >
            <div className="tool-explorer tool-drawer-body">{details}</div>
          </PaneDrawer>
        </>
      )}
    </div>
  );
}

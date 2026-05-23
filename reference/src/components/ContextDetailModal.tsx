import React, { useEffect, type ReactNode } from 'react';
import { X, Gauge } from 'lucide-react';
import { Button } from './ui/button';
import { PieChart, resolveColor, type PieSegment } from './ContextDetail/PieChart';
import { formatTokens, getPctColor } from '../utils/formatTokens';

const TH =
  'text-left py-1.5 px-2.5 text-muted-foreground font-medium border-b border-border whitespace-nowrap';
const TH_RIGHT =
  'text-right py-1.5 px-2.5 text-muted-foreground font-medium border-b border-border whitespace-nowrap';
const TD = 'py-1.5 px-2.5 border-b border-border/40';
const TD_NUM =
  'text-right py-1.5 px-2.5 border-b border-border/40 tabular-nums';

interface SystemPromptSection {
  name: string;
  tokens: number;
}

interface MemoryFile {
  path: string;
  type: string;
  tokens: number;
}

interface McpToolEntry {
  name: string;
  serverName: string;
  tokens: number;
  isLoaded: boolean;
}

interface SystemToolEntry {
  name: string;
  tokens: number;
}

interface DeferredBuiltinToolEntry {
  name: string;
  tokens: number;
  isLoaded: boolean;
}

export interface ContextUsageData {
  model?: string;
  totalTokens: number;
  maxTokens: number;
  percentage?: number;
  categories?: PieSegment[];
  systemPromptSections?: SystemPromptSection[];
  memoryFiles?: MemoryFile[];
  mcpTools?: McpToolEntry[];
  systemTools?: SystemToolEntry[];
  deferredBuiltinTools?: DeferredBuiltinToolEntry[];
}

export interface ContextDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  contextUsage: ContextUsageData | null | undefined;
  isLoading?: boolean;
  error?: string | null;
}

interface SectionLabelProps {
  children?: ReactNode;
}

function SectionLabel({ children }: SectionLabelProps) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

interface SummaryBarProps {
  data: ContextUsageData;
}

function SummaryBar({ data }: SummaryBarProps) {
  const pct = Math.min(100, Math.round(data.percentage ?? 0));
  const color = getPctColor(pct);
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-[13px] text-muted-foreground bg-muted px-2.5 py-1 rounded border border-border">
        {data.model || 'Unknown'}
      </span>
      <span className="text-[15px] font-semibold text-foreground">
        {formatTokens(data.totalTokens)} / {formatTokens(data.maxTokens)}
      </span>
      <span
        className="text-[13px] py-0.5 px-2 rounded font-semibold"
        style={{ color, border: `1px solid ${color}` }}
      >
        {pct}%
      </span>
      <span className="flex-1 min-w-[100px] h-2 bg-muted rounded overflow-hidden">
        <span
          className="block h-full rounded transition-all duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </span>
    </div>
  );
}

interface CategoriesTableProps {
  categories: PieSegment[];
  denominator: number;
}

function CategoriesTable({ categories, denominator }: CategoriesTableProps) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Categories</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH}>Category</th>
              <th className={TH_RIGHT}>Tokens</th>
              <th className={TH_RIGHT}>%</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, i) => (
              <tr key={i}>
                <td className={TD}>
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm mr-2 align-middle"
                    style={{ background: resolveColor(cat.color, cat.name) }}
                  />
                  {cat.name}
                </td>
                <td className={TD_NUM}>{formatTokens(cat.tokens)}</td>
                <td className={TD_NUM}>
                  {denominator > 0
                    ? Math.round((cat.tokens / denominator) * 100)
                    : 0}
                  %
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface SimpleRow {
  label: string;
  tokens: number;
}

interface SimpleTwoColTableProps {
  rows: SimpleRow[];
  leftHeader: string;
  rightHeader: string;
}

function SimpleTwoColTable({
  rows,
  leftHeader,
  rightHeader,
}: SimpleTwoColTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className={TH}>{leftHeader}</th>
            <th className={TH_RIGHT}>{rightHeader}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className={TD}>{r.label}</td>
              <td className={TD_NUM}>{formatTokens(r.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SystemPromptSectionView({
  sections,
}: {
  sections: SystemPromptSection[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>System Prompt Sections</SectionLabel>
      <SimpleTwoColTable
        rows={sections.map((s) => ({ label: s.name, tokens: s.tokens }))}
        leftHeader="Section"
        rightHeader="Tokens"
      />
    </div>
  );
}

function MemoryFilesSection({ files }: { files: MemoryFile[] }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Memory Files</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH}>Path</th>
              <th className={TH}>Type</th>
              <th className={TH_RIGHT}>Tokens</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, i) => (
              <tr key={i}>
                <td className={`${TD} break-all`}>{f.path}</td>
                <td className={TD}>{f.type}</td>
                <td className={TD_NUM}>{formatTokens(f.tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function McpToolsSection({ tools }: { tools: McpToolEntry[] }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>MCP Tools</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH}>Tool</th>
              <th className={TH}>Server</th>
              <th className={TH_RIGHT}>Tokens</th>
              <th className={TH}>Status</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t, i) => (
              <tr key={i}>
                <td className={`${TD} break-all`}>{t.name}</td>
                <td className={TD}>{t.serverName}</td>
                <td className={TD_NUM}>{formatTokens(t.tokens)}</td>
                <td className={TD}>
                  {t.isLoaded ? (
                    <span className="text-green-600 dark:text-green-400 text-[11px]">
                      Loaded
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-[11px]">
                      Deferred
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SystemToolsSection({ tools }: { tools: SystemToolEntry[] }) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>System Tools</SectionLabel>
      <SimpleTwoColTable
        rows={tools.map((t) => ({ label: t.name, tokens: t.tokens }))}
        leftHeader="Tool"
        rightHeader="Tokens"
      />
    </div>
  );
}

function DeferredBuiltinToolsSection({
  tools,
}: {
  tools: DeferredBuiltinToolEntry[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Deferred Builtin Tools</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={TH}>Tool</th>
              <th className={TH_RIGHT}>Tokens</th>
              <th className={TH}>Status</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((t, i) => (
              <tr key={i}>
                <td className={TD}>{t.name}</td>
                <td className={TD_NUM}>{formatTokens(t.tokens)}</td>
                <td className={TD}>
                  {t.isLoaded ? (
                    <span className="text-green-600 dark:text-green-400 text-[11px]">
                      Loaded
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-[11px]">
                      Deferred
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContextDetailModal({
  isOpen,
  onClose,
  contextUsage,
  isLoading,
  error,
}: ContextDetailModalProps) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const data = contextUsage;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div
        className="relative bg-card rounded-lg shadow-xl border border-border w-full mx-4 max-w-[700px] max-h-[85vh] flex flex-col"
        role="dialog"
        aria-label="Context Usage Details"
      >
        <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Gauge className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-foreground">
              Context Usage
            </h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 flex flex-col gap-6">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Loading context usage...
            </div>
          )}

          {!isLoading && (error || !data) && (
            <div className="flex flex-col items-center justify-center py-12 text-sm text-muted-foreground gap-2 text-center">
              <span>No context usage data yet.</span>
              <span className="text-xs">
                Send a message to populate this view.
              </span>
            </div>
          )}

          {!isLoading && data && (
            <>
              <SummaryBar data={data} />

              {Array.isArray(data.categories) && data.categories.length > 0 && (
                <>
                  <PieChart segments={data.categories} />
                  <CategoriesTable
                    categories={data.categories}
                    denominator={data.maxTokens || data.totalTokens}
                  />
                </>
              )}

              {Array.isArray(data.systemPromptSections) &&
                data.systemPromptSections.length > 0 && (
                  <SystemPromptSectionView
                    sections={data.systemPromptSections}
                  />
                )}

              {Array.isArray(data.memoryFiles) && data.memoryFiles.length > 0 && (
                <MemoryFilesSection files={data.memoryFiles} />
              )}

              {Array.isArray(data.mcpTools) && data.mcpTools.length > 0 && (
                <McpToolsSection tools={data.mcpTools} />
              )}

              {Array.isArray(data.systemTools) && data.systemTools.length > 0 && (
                <SystemToolsSection tools={data.systemTools} />
              )}

              {Array.isArray(data.deferredBuiltinTools) &&
                data.deferredBuiltinTools.length > 0 && (
                  <DeferredBuiltinToolsSection
                    tools={data.deferredBuiltinTools}
                  />
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ContextDetailModal;

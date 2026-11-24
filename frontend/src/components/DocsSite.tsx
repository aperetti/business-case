import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Code,
  Divider,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconArrowBackUp,
  IconArrowLeft,
  IconArrowRight,
  IconBook,
  IconEdit,
  IconMessageCircle,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import {
  CATALOG_ITEM_DOCS,
  GUIDE_PAGES,
  computeExampleResult,
  getCatalogItemDoc,
  type GuideDocPage,
} from '../data/catalogDocs';
import type {
  CatalogEntry,
  InitiativeDetail,
  InitiativeItemCreate,
  LLMSettingsOut,
} from '../types/api';
import { formatCurrency, formatPercent } from '../utils/format';
import { DocsAgentChat } from './DocsAgentChat';
import { CatalogDocEditor } from './CatalogDocEditor';
import { api } from '../api/client';
import { notifications } from '@mantine/notifications';

interface Props {
  catalog: CatalogEntry[];
  activeSlug: string;
  onSelectSlug: (slug: string) => void;
  hasActiveInitiative: boolean;
  onUseTemplate?: (draft: Partial<InitiativeItemCreate>) => void;
  llmSettings: LLMSettingsOut | null;
  activeInitiative?: InitiativeDetail | null;
  onOpenAdmin: () => void;
  onOpenChatDrawer?: () => void;
  /** Whether the viewer may edit catalog templates and their documentation. */
  canManageCatalog?: boolean;
  onCatalogEntryChanged?: (entry: CatalogEntry) => void;
}

interface NavEntry {
  slug: string;
  title: string;
  shortLabel: string;
  group: 'Guides' | 'Cost Templates' | 'Benefit Templates' | 'Custom Templates';
  kind?: 'cost' | 'benefit';
}

const RAMP_LABELS: Record<string, string> = {
  immediate: 'Immediate (100%)',
  linear: 'Linear ramp',
  s_curve: 'S-Curve ramp',
  custom_weights: 'Custom weights',
};

const CODE_BLOCK_STYLE: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-body)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};

export function DocsSite({
  catalog,
  activeSlug: activeRoute,
  onSelectSlug,
  hasActiveInitiative,
  onUseTemplate,
  llmSettings,
  activeInitiative,
  onOpenAdmin,
  onOpenChatDrawer,
  canManageCatalog = false,
  onCatalogEntryChanged,
}: Props) {
  // Routes may carry a section anchor: "<slug>#<section-id>".
  const [activeSlug, activeAnchor] = activeRoute.split('#');
  const isCompactNav = useMediaQuery('(max-width: 62em)') ?? false;
  useEffect(() => {
    if (!activeAnchor) return;
    const timer = window.setTimeout(() => {
      const el = document.getElementById(activeAnchor);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.setAttribute('data-highlight', 'true');
        window.setTimeout(() => el.removeAttribute('data-highlight'), 2000);
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [activeRoute, activeAnchor]);
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [navFilter, setNavFilter] = useState('');

  const { orderedPages, selectData } = useMemo(() => {
    const pages: NavEntry[] = [
      {
        slug: 'ask',
        title: 'Ask Docs Agent',
        shortLabel: 'AI Q&A assistant',
        group: 'Guides',
      },
    ];

    for (const g of GUIDE_PAGES) {
      pages.push({
        slug: g.slug,
        title: g.title,
        shortLabel: g.title,
        group: 'Guides',
      });
    }

    const builtinCosts = catalog.filter((c) => c.is_builtin && c.kind === 'cost');
    const builtinBenefits = catalog.filter((c) => c.is_builtin && c.kind === 'benefit');
    const customEntries = catalog.filter((c) => !c.is_builtin);

    for (const c of builtinCosts) {
      pages.push({
        slug: c.id,
        title: `${c.id} — ${c.name}`,
        shortLabel: c.name,
        group: 'Cost Templates',
        kind: c.kind,
      });
    }

    for (const b of builtinBenefits) {
      pages.push({
        slug: b.id,
        title: `${b.id} — ${b.name}`,
        shortLabel: b.name,
        group: 'Benefit Templates',
        kind: b.kind,
      });
    }

    for (const custom of customEntries) {
      pages.push({
        slug: custom.id,
        title: `${custom.id} — ${custom.name}`,
        shortLabel: custom.name,
        group: 'Custom Templates',
        kind: custom.kind,
      });
    }

    const groups: ('Guides' | 'Cost Templates' | 'Benefit Templates' | 'Custom Templates')[] = [
      'Guides',
      'Cost Templates',
      'Benefit Templates',
      'Custom Templates',
    ];

    const groupedSelect = groups
      .map((group) => ({
        group,
        items: pages
          .filter((p) => p.group === group)
          .map((p) => ({ value: p.slug, label: p.title })),
      }))
      .filter((g) => g.items.length > 0);

    return { orderedPages: pages, selectData: groupedSelect };
  }, [catalog]);

  const filteredNavPages = useMemo(() => {
    const q = navFilter.trim().toLowerCase();
    if (!q) return orderedPages;
    return orderedPages.filter(
      (p) =>
        p.slug.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        p.shortLabel.toLowerCase().includes(q)
    );
  }, [orderedPages, navFilter]);

  const activeGuide: GuideDocPage | undefined = useMemo(
    () => GUIDE_PAGES.find((g) => g.slug === activeSlug),
    [activeSlug]
  );

  const activeCatalogEntry: CatalogEntry | undefined = useMemo(
    () => catalog.find((c) => c.id === activeSlug),
    [catalog, activeSlug]
  );

  const isAskPage = activeSlug === 'ask';

  const resolvedSlug = isAskPage
    ? 'ask'
    : activeGuide
      ? activeGuide.slug
      : activeCatalogEntry
        ? activeCatalogEntry.id
        : GUIDE_PAGES[0].slug;

  const resolvedGuide =
    !isAskPage ? activeGuide ?? (!activeCatalogEntry ? GUIDE_PAGES[0] : undefined) : undefined;

  const currentIdx = orderedPages.findIndex((p) => p.slug === resolvedSlug);
  const prevPage = currentIdx > 0 ? orderedPages[currentIdx - 1] : null;
  const nextPage =
    currentIdx >= 0 && currentIdx < orderedPages.length - 1
      ? orderedPages[currentIdx + 1]
      : null;

  const navGroups: ('Guides' | 'Cost Templates' | 'Benefit Templates' | 'Custom Templates')[] = [
    'Guides',
    'Cost Templates',
    'Benefit Templates',
    'Custom Templates',
  ];

  return (
    <div className="docs-layout">
      {!isCompactNav && (
        <aside className="docs-sidebar" aria-label="Documentation navigation">
          <Paper withBorder p="xs" radius="md" bg="var(--bg-surface)">
            <Stack gap="sm">
              <search>
                <TextInput
                  size="xs"
                  aria-label="Filter documentation pages"
                  placeholder="Filter guides & templates..."
                  leftSection={<IconSearch size={13} />}
                  value={navFilter}
                  onChange={(e) => setNavFilter(e.currentTarget.value)}
                />
              </search>

              {navGroups.map((group) => {
                const items = filteredNavPages.filter((p) => p.group === group);
                if (items.length === 0) return null;
                return (
                  <div key={group}>
                    <Text
                      size="xs"
                      fw={700}
                      tt="uppercase"
                      c="var(--text-muted)"
                      px={8}
                      mb={4}
                      style={{ letterSpacing: '0.04em', fontSize: 11 }}
                    >
                      {group}
                    </Text>
                    <Stack gap={2}>
                      {items.map((item) => {
                        const isActive = item.slug === resolvedSlug;
                        return (
                          <button
                            key={item.slug}
                            type="button"
                            className="docs-nav-item"
                            data-active={isActive ? 'true' : 'false'}
                            onClick={() => onSelectSlug(item.slug)}
                          >
                            {item.kind ? (
                              <span
                                className="status-dot"
                                style={{
                                  backgroundColor:
                                    item.kind === 'cost' ? 'var(--chart-neg)' : 'var(--chart-pos)',
                                  marginTop: 2,
                                }}
                              />
                            ) : item.slug === 'ask' ? (
                              <IconMessageCircle
                                size={13}
                                style={{
                                  flexShrink: 0,
                                  color: 'var(--accent-primary)',
                                  opacity: isActive ? 1 : 0.85,
                                }}
                              />
                            ) : (
                              <IconBook
                                size={13}
                                style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7 }}
                              />
                            )}
                            <span style={{ minWidth: 0 }}>
                              {item.kind ? (
                                <>
                                  <Text
                                    span
                                    display="block"
                                    size="xs"
                                    ff="monospace"
                                    fw={600}
                                    c={isActive ? 'var(--text-heading)' : 'var(--text-body)'}
                                  >
                                    {item.slug}
                                  </Text>
                                  <Text
                                    span
                                    display="block"
                                    size="xs"
                                    c="var(--text-muted)"
                                    style={{ lineHeight: 1.3 }}
                                  >
                                    {item.shortLabel}
                                  </Text>
                                </>
                              ) : (
                                <Text span size="xs" fw={isActive ? 600 : 500} style={{ color: 'inherit' }}>
                                  {item.title}
                                </Text>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </Stack>
                  </div>
                );
              })}

              {filteredNavPages.length === 0 && (
                <Text size="xs" c="var(--text-muted)" px={8}>
                  No matching pages.
                </Text>
              )}
            </Stack>
          </Paper>
        </aside>
      )}

      <div className="docs-content">
        <Stack gap="md" style={{ minWidth: 0 }}>
          {isCompactNav && (
            <Paper withBorder p="sm" radius="md" bg="var(--bg-surface)">
              <Select
                label="Documentation Page"
                aria-label="Select documentation page"
                data={selectData}
                value={resolvedSlug}
                onChange={(val) => val && onSelectSlug(val)}
                searchable
                allowDeselect={false}
              />
            </Paper>
          )}

          {isAskPage ? (
            <Stack gap="md" style={{ minWidth: 0 }}>
              <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
                <Text size="xs" fw={600} c="var(--accent-primary)" mb={4}>
                  Interactive Assistant · OpenAI-Compatible
                </Text>
                <Title order={2} size={isMobile ? 'h3' : 'h2'} mb={4}>
                  Ask the ValueStream Docs Agent
                </Title>
                <Text size="sm" c="var(--text-muted)">
                  Ask natural-language questions across all catalog items, worked examples, methodology formulas, guardrails, and your active initiative.
                </Text>
              </Paper>

              <DocsAgentChat
                llmSettings={llmSettings}
                activeInitiative={activeInitiative}
                onNavigateDoc={onSelectSlug}
                onOpenAdmin={onOpenAdmin}
              />
            </Stack>
          ) : resolvedGuide ? (
            <GuidePageView
              guide={resolvedGuide}
              catalog={catalog}
              isMobile={isMobile}
              onSelectSlug={onSelectSlug}
            />
          ) : activeCatalogEntry ? (
            <CatalogItemDocView
              entry={activeCatalogEntry}
              catalog={catalog}
              canManage={canManageCatalog}
              onEntryChanged={onCatalogEntryChanged}
              isMobile={isMobile}
              hasActiveInitiative={hasActiveInitiative}
              onSelectSlug={onSelectSlug}
              onUseTemplate={onUseTemplate}
              onOpenChatDrawer={onOpenChatDrawer}
            />
          ) : null}

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            {prevPage ? (
              <Paper
                component="button"
                type="button"
                withBorder
                p="sm"
                radius="md"
                bg="var(--bg-surface)"
                onClick={() => onSelectSlug(prevPage.slug)}
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <Group gap={6} c="var(--text-muted)" mb={2}>
                  <IconArrowLeft size={14} />
                  <Text size="xs">Previous</Text>
                </Group>
                <Text size="sm" fw={600} c="var(--text-heading)">
                  {prevPage.title}
                </Text>
              </Paper>
            ) : (
              <div />
            )}

            {nextPage && (
              <Paper
                component="button"
                type="button"
                withBorder
                p="sm"
                radius="md"
                bg="var(--bg-surface)"
                onClick={() => onSelectSlug(nextPage.slug)}
                style={{
                  textAlign: 'right',
                  cursor: 'pointer',
                  width: '100%',
                }}
              >
                <Group gap={6} justify="flex-end" c="var(--text-muted)" mb={2}>
                  <Text size="xs">Next</Text>
                  <IconArrowRight size={14} />
                </Group>
                <Text size="sm" fw={600} c="var(--text-heading)">
                  {nextPage.title}
                </Text>
              </Paper>
            )}
          </SimpleGrid>
        </Stack>
      </div>
    </div>
  );
}

function SeeAlsoLinks({
  links,
  onSelectSlug,
}: {
  links?: { slug: string; label: string }[];
  onSelectSlug: (slug: string) => void;
}) {
  if (!links || links.length === 0) return null;
  return (
    <Group gap="xs">
      {links.map((link) => (
        <Button
          key={link.slug}
          type="button"
          size="compact-xs"
          variant="subtle"
          px={4}
          rightSection={<IconArrowRight size={12} />}
          onClick={() => onSelectSlug(link.slug)}
        >
          See also: {link.label}
        </Button>
      ))}
    </Group>
  );
}

export function GuidePageView({
  guide,
  catalog,
  isMobile,
  onSelectSlug,
}: {
  guide: GuideDocPage;
  catalog: CatalogEntry[];
  isMobile: boolean;
  onSelectSlug: (slug: string) => void;
}) {
  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Text size="xs" fw={600} c="var(--accent-primary)" mb={4}>
          Guide · Methodology & Reference
        </Text>
        <Title order={2} size={isMobile ? 'h3' : 'h2'} mb={4}>
          {guide.title}
        </Title>
        <Text size="sm" c="var(--text-muted)">
          {guide.subtitle}
        </Text>
      </Paper>

      {guide.sections.map((sec) => (
        <Paper
          key={sec.id ?? sec.heading}
          id={sec.id}
          className="docs-section"
          withBorder
          p={{ base: 'sm', sm: 'md' }}
          radius="md"
          bg="var(--bg-surface)"
        >
          <Stack gap="sm" style={{ minWidth: 0 }}>
            <div>
              {sec.eyebrow && (
                <Text size="xs" fw={600} c="var(--text-muted)" tt="uppercase" style={{ letterSpacing: '0.04em' }}>
                  {sec.eyebrow}
                </Text>
              )}
              <Title order={4}>{sec.heading}</Title>
            </div>

            {sec.paragraphs?.map((p, idx) => (
              <Text key={idx} size="sm" c="var(--text-body)" lh={1.6}>
                {p}
              </Text>
            ))}

            {sec.bullets && sec.bullets.length > 0 && (
              <ul className="docs-list">
                {sec.bullets.map((b, idx) => (
                  <li key={idx}>{b}</li>
                ))}
              </ul>
            )}

            {sec.formula && (
              <Code block style={CODE_BLOCK_STYLE}>
                {sec.formula}
              </Code>
            )}

            {sec.callout && (
              <div className="callout-note" role="note">
                {sec.callout}
              </div>
            )}

            <SeeAlsoLinks links={sec.links} onSelectSlug={onSelectSlug} />

            {sec.table && (
              <div
                tabIndex={0}
                role="region"
                aria-label={sec.heading}
                className="table-region"
              >
                <Table verticalSpacing={6} horizontalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      {sec.table.headers.map((h) => (
                        <Table.Th key={h}>{h}</Table.Th>
                      ))}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {sec.table.rows.map((row, rIdx) => (
                      <Table.Tr key={rIdx}>
                        {row.map((cell, cIdx) => (
                          <Table.Td
                            key={cIdx}
                            className={cIdx >= 1 ? 'cell-wrap' : undefined}
                            ff={cIdx === 0 ? 'monospace' : undefined}
                            fw={cIdx === 0 ? 600 : undefined}
                          >
                            {cell}
                          </Table.Td>
                        ))}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            )}

            {sec.entries && sec.entries.length > 0 && (
              <Stack gap={0}>
                {sec.entries.map((entry, idx) => (
                  <Fragment key={entry.id ?? entry.heading}>
                    {idx > 0 && <Divider color="var(--border-divider)" />}
                    <div id={entry.id} className="docs-entry">
                      <Stack gap={6}>
                        <Title order={5}>{entry.heading}</Title>
                        {entry.paragraphs?.map((p, pIdx) => (
                          <Text key={pIdx} size="sm" c="var(--text-body)" lh={1.6}>
                            {p}
                          </Text>
                        ))}
                        <SeeAlsoLinks links={entry.links} onSelectSlug={onSelectSlug} />
                      </Stack>
                    </div>
                  </Fragment>
                ))}
              </Stack>
            )}
          </Stack>
        </Paper>
      ))}

      {guide.slug === 'overview' && (
        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Stack gap="sm">
            <div>
              <Title order={4}>Catalog Template Reference Directory ({catalog.length})</Title>
              <Text size="xs" c="var(--text-muted)">
                Select any cost or benefit template below for parameter guidance, double-counting checks, and worked PV calculations.
              </Text>
            </div>

            {isMobile ? (
              <Stack gap={0}>
                {catalog.map((entry, idx) => {
                  const isCost = entry.kind === 'cost';
                  const exCount = (CATALOG_ITEM_DOCS[entry.id]?.examples.length ?? 1);
                  return (
                    <Fragment key={entry.id}>
                      {idx > 0 && <Divider color="var(--border-divider)" my="xs" />}
                      <Stack gap={4}>
                        <Group justify="space-between" wrap="wrap" gap="xs">
                          <Group gap={6}>
                            <span
                              className="status-dot"
                              style={{
                                backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)',
                              }}
                            />
                            <Text
                              size="xs"
                              fw={600}
                              c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                            >
                              {isCost ? 'Cost' : 'Benefit'}
                            </Text>
                            <Text size="xs" ff="monospace" fw={600} c="var(--text-heading)">
                              · {entry.id}
                            </Text>
                          </Group>
                          <Button
                            type="button"
                            size="compact-xs"
                            variant="default"
                            onClick={() => onSelectSlug(entry.id)}
                          >
                            Open Guide
                          </Button>
                        </Group>
                        <Text size="sm" fw={600} c="var(--text-heading)">
                          {entry.name}
                        </Text>
                        <Text
                          size="xs"
                          ff="monospace"
                          c="var(--text-muted)"
                          style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                        >
                          {entry.formula_description}
                        </Text>
                        <Text size="xs" c="var(--text-muted)">
                          {entry.is_builtin ? 'Built-in' : 'Custom'} · {entry.parameters.length} params · {exCount} worked example{exCount > 1 ? 's' : ''}
                        </Text>
                      </Stack>
                    </Fragment>
                  );
                })}
              </Stack>
            ) : (
              <div
                tabIndex={0}
                role="region"
                aria-label="Catalog template directory"
                className="table-region"
              >
                <Table verticalSpacing={6} horizontalSpacing="xs">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>ID</Table.Th>
                      <Table.Th>Kind</Table.Th>
                      <Table.Th>Name & Stage</Table.Th>
                      <Table.Th>Formula</Table.Th>
                      <Table.Th ta="right">Guide</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {catalog.map((entry) => {
                      const isCost = entry.kind === 'cost';
                      return (
                        <Table.Tr key={entry.id}>
                          <Table.Td ff="monospace" fw={600}>
                            {entry.id}
                          </Table.Td>
                          <Table.Td>
                            <Group gap={6} wrap="nowrap">
                              <span
                                className="status-dot"
                                style={{
                                  backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)',
                                }}
                              />
                              <Text
                                size="xs"
                                fw={600}
                                c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                              >
                                {isCost ? 'Cost' : 'Benefit'}
                              </Text>
                            </Group>
                          </Table.Td>
                          <Table.Td className="cell-wrap">
                            <Text size="xs" fw={600} c="var(--text-heading)">
                              {entry.name}
                            </Text>
                            <Text size="xs" c="var(--text-muted)">
                              {entry.is_builtin ? 'Built-in' : 'Custom'}
                              {entry.value_stream_stage ? ` · ${entry.value_stream_stage}` : ''}
                            </Text>
                          </Table.Td>
                          <Table.Td className="cell-wrap" ff="monospace">
                            <Text size="xs" ff="monospace" c="var(--text-muted)">
                              {entry.formula_description}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Button
                              type="button"
                              size="compact-xs"
                              variant="default"
                              onClick={() => onSelectSlug(entry.id)}
                            >
                              Read Guide
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                  </Table.Tbody>
                </Table>
              </div>
            )}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}

/** Shows a section's text, or a fill-in prompt when an auto-created page leaves it empty. */
function DocText({ text, prompt, size = 'sm' }: { text: string; prompt: string; size?: 'xs' | 'sm' }) {
  if (text.trim()) {
    return (
      <Text size={size} c="var(--text-body)" lh={1.6} style={{ whiteSpace: 'pre-wrap' }}>
        {text}
      </Text>
    );
  }
  return (
    <Text size={size} c="var(--text-muted)" fs="italic" lh={1.5}>
      To fill in: {prompt}
    </Text>
  );
}

export function CatalogItemDocView({
  entry,
  embedded = false,
  catalog,
  canManage,
  onEntryChanged,
  isMobile,
  hasActiveInitiative,
  onSelectSlug,
  onUseTemplate,
  onOpenChatDrawer,
}: {
  entry: CatalogEntry;
  /** Rendered inside the line-item drawer: actions fill that form instead of opening a new item. */
  embedded?: boolean;
  catalog: CatalogEntry[];
  canManage: boolean;
  onEntryChanged?: (entry: CatalogEntry) => void;
  isMobile: boolean;
  hasActiveInitiative: boolean;
  onSelectSlug: (slug: string) => void;
  onUseTemplate?: (draft: Partial<InitiativeItemCreate>) => void;
  onOpenChatDrawer?: () => void;
}) {
  const doc = useMemo(() => getCatalogItemDoc(entry), [entry]);
  const isCost = entry.kind === 'cost';
  const [editorOpen, setEditorOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    if (!window.confirm(`Discard edits to the ${entry.id} documentation and restore the shipped version?`)) return;
    setResetting(true);
    try {
      onEntryChanged?.(await api.resetCatalogDoc(entry.id));
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Reset failed',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    } finally {
      setResetting(false);
    }
  };

  return (
    <Stack gap="md" style={{ minWidth: 0 }}>
      {doc.isTemplate && (
        <Alert color="yellow" variant="light" title="This documentation page needs to be written">
          <Stack gap="xs">
            <Text size="sm">
              It was created automatically for this new template. Each section below shows what to fill in.
            </Text>
            {canManage && (
              <Button size="xs" w="fit-content" leftSection={<IconEdit size={13} />} onClick={() => setEditorOpen(true)}>
                Fill Out Documentation
              </Button>
            )}
          </Stack>
        </Alert>
      )}
      {canManage && (
        <CatalogDocEditor
          entry={entry}
          catalog={catalog}
          opened={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSaved={(updated) => onEntryChanged?.(updated)}
        />
      )}
      {/* Header Card */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <Group gap={6} mb={4} wrap="wrap">
              <span
                className="status-dot"
                style={{ backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)' }}
              />
              <Text size="xs" fw={600} c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}>
                {isCost ? 'Cost' : 'Benefit'}
              </Text>
              <Text size="xs" ff="monospace" fw={600} c="var(--text-heading)">
                · {entry.id}
              </Text>
              <Text size="xs" c="var(--text-muted)">
                · {entry.is_builtin ? 'Built-in' : 'Custom'}
                {entry.value_stream_stage ? ` · Stage: ${entry.value_stream_stage}` : ''}
                {entry.domains.length > 0 ? ` · Domains: ${entry.domains.join(', ')}` : ''}
              </Text>
            </Group>
            <Title order={2} size={isMobile ? 'h3' : 'h2'} mb={4}>
              {entry.name}
            </Title>
            {doc.headline ? (
              <Text size="sm" c="var(--text-muted)">
                {doc.headline}
              </Text>
            ) : (
              <DocText text="" prompt="a one-sentence headline." />
            )}
            {doc.isEdited && entry.doc && (
              <Text size="xs" c="var(--text-muted)" mt={4}>
                Edited {new Date(entry.doc.updated_at).toLocaleDateString()}
                {entry.doc.updated_by ? ` by ${entry.doc.updated_by}` : ''}
              </Text>
            )}
          </div>

          <Group gap="xs" wrap="wrap">
            {canManage && (
              <Button
                type="button"
                size="xs"
                variant="default"
                leftSection={<IconEdit size={13} />}
                onClick={() => setEditorOpen(true)}
              >
                Edit Page
              </Button>
            )}
            {canManage && entry.is_builtin && entry.doc && (
              <Button
                type="button"
                size="xs"
                variant="subtle"
                color="gray"
                loading={resetting}
                leftSection={<IconArrowBackUp size={13} />}
                onClick={handleReset}
              >
                Reset to Default
              </Button>
            )}
            {onOpenChatDrawer && (
              <Button
                type="button"
                size="xs"
                variant="default"
                leftSection={<IconMessageCircle size={13} color="var(--accent-primary)" />}
                onClick={onOpenChatDrawer}
              >
                Ask Docs
              </Button>
            )}
            {hasActiveInitiative && onUseTemplate && (
              <Button
                type="button"
                size="xs"
                variant="default"
                leftSection={<IconPlus size={14} />}
                onClick={() => onUseTemplate({ catalog_id: entry.id })}
              >
                {embedded ? 'Use This Template' : 'Add to Initiative'}
              </Button>
            )}
          </Group>
        </Group>
      </Paper>

      {/* What It Measures & Economic Rationale */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="sm">
          <div>
            <Title order={4} mb={4}>
              What It Measures
            </Title>
            <DocText text={doc.whatItMeasures} prompt="the quantity being valued, its unit, and where the numbers come from." />
          </div>
          <Divider color="var(--border-divider)" />
          <div>
            <Title order={4} mb={4}>
              Economic Rationale
            </Title>
            <DocText text={doc.economicRationale} prompt="why this is a real cost or benefit and how it shows up in financials." />
          </div>
        </Stack>
      </Paper>

      {/* When to Use vs When Not to Use */}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Title order={5} mb="xs" c="var(--text-heading)">
            When to Use {entry.id}
          </Title>
          {doc.whenToUse.length === 0 ? (
            <DocText text="" prompt="the situations this template is meant for." />
          ) : (
            <ul className="docs-list">
              {doc.whenToUse.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          )}
        </Paper>

        <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
          <Title order={5} mb="xs" c="var(--text-heading)">
            When to Use Another Template
          </Title>
          <Stack gap="xs">
            {doc.whenNotToUse.length === 0 && (
              <DocText text="" prompt="cases that belong in a different template, and which one." />
            )}
            {doc.whenNotToUse.map((alt, idx) => (
              <div key={idx}>
                <Text size="sm" c="var(--text-body)" lh={1.5}>
                  {alt.text}
                </Text>
                {alt.linkSlug && (
                  <Button
                    type="button"
                    size="compact-xs"
                    variant="subtle"
                    mt={2}
                    px={4}
                    rightSection={<IconArrowRight size={12} />}
                    onClick={() => onSelectSlug(alt.linkSlug!)}
                  >
                    {alt.linkLabel || alt.linkSlug}
                  </Button>
                )}
              </div>
            ))}
          </Stack>
        </Paper>
      </SimpleGrid>

      {/* Formula & Parameter Reference */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="sm" style={{ minWidth: 0 }}>
          <div>
            <Title order={4} mb={4}>
              Formula & Parameter Reference
            </Title>
            <Box mb="xs">
              <DocText text={doc.formulaPlainEnglish} prompt="explain the calculation below in words." />
            </Box>
            <Code block style={CODE_BLOCK_STYLE}>
              {entry.formula_description}
            </Code>
          </div>

          {isMobile ? (
            <Stack gap={0}>
              {entry.parameters.map((p, idx) => {
                const guide = doc.parameterGuidance[p.key];
                return (
                  <Fragment key={p.key}>
                    {idx > 0 && <Divider color="var(--border-divider)" my="xs" />}
                    <Stack gap={3}>
                      <Group justify="space-between" wrap="wrap" gap={4}>
                        <Code style={{ background: 'var(--bg-subtle)', color: 'var(--text-heading)' }}>
                          {p.key}
                        </Code>
                        <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                          {p.unit || 'unitless'} · Default {p.default_value}
                        </Text>
                      </Group>
                      <Text size="xs" fw={600} c="var(--text-heading)">
                        {p.label}
                      </Text>
                      <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                        Bounds [{p.min_value ?? '−∞'}, {p.max_value ?? '∞'}]
                        {guide?.typicalRange ? ` · Typical ${guide.typicalRange}` : ''}
                      </Text>
                      {guide && (
                        <>
                          <Text size="xs" c="var(--text-body)">
                            {guide.guidance}
                          </Text>
                          <Text size="xs" c="var(--text-muted)">
                            Source: {guide.dataSource}
                          </Text>
                        </>
                      )}
                    </Stack>
                  </Fragment>
                );
              })}
            </Stack>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-label={`${entry.id} parameter reference`}
              className="table-region"
            >
              <Table verticalSpacing={6} horizontalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Parameter Key</Table.Th>
                    <Table.Th>Unit</Table.Th>
                    <Table.Th>Default & Bounds</Table.Th>
                    <Table.Th>Typical Range</Table.Th>
                    <Table.Th>Estimation Guidance & Data Source</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {entry.parameters.map((p) => {
                    const guide = doc.parameterGuidance[p.key];
                    return (
                      <Table.Tr key={p.key}>
                        <Table.Td>
                          <Code style={{ background: 'var(--bg-subtle)', color: 'var(--text-heading)' }}>
                            {p.key}
                          </Code>
                          <Text size="xs" c="var(--text-muted)" mt={2}>
                            {p.label}
                          </Text>
                        </Table.Td>
                        <Table.Td>{p.unit || '—'}</Table.Td>
                        <Table.Td className="tabular-nums">
                          <Text size="xs" fw={600} c="var(--text-heading)">
                            {p.default_value}
                          </Text>
                          <Text size="xs" c="var(--text-muted)">
                            [{p.min_value ?? '−∞'}, {p.max_value ?? '∞'}]
                          </Text>
                        </Table.Td>
                        <Table.Td className="tabular-nums">
                          {guide?.typicalRange || '—'}
                        </Table.Td>
                        <Table.Td className="cell-wrap">
                          {guide ? (
                            <>
                              <Text size="xs" c="var(--text-body)">
                                {guide.guidance}
                              </Text>
                              <Text size="xs" c="var(--text-muted)" mt={2}>
                                Source: {guide.dataSource}
                              </Text>
                            </>
                          ) : (
                            p.label
                          )}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </Stack>
      </Paper>

      {/* Recommended Schedule, Ramp & Monte Carlo Setup */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Title order={4} mb="xs">
          Recommended Schedule, Ramp & Uncertainty Setup
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
            <Text size="xs" fw={600} c="var(--text-heading)" mb={2}>
              Active Years
            </Text>
            <DocText size="xs" text={doc.modelingTips.schedule} prompt="which years this item should be active." />
          </Paper>
          <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
            <Text size="xs" fw={600} c="var(--text-heading)" mb={2}>
              Ramp Profile
            </Text>
            <DocText size="xs" text={doc.modelingTips.ramp} prompt="which ramp profile fits how the value builds up." />
          </Paper>
          <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
            <Text size="xs" fw={600} c="var(--text-heading)" mb={2}>
              Monte Carlo Distribution
            </Text>
            <DocText size="xs" text={doc.modelingTips.uncertainty} prompt="which inputs are uncertain and how to model them." />
          </Paper>
          <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
            <Text size="xs" fw={600} c="var(--text-heading)" mb={2}>
              Correlation Group
            </Text>
            <DocText size="xs" text={doc.modelingTips.correlation} prompt="which other line items move together with this one." />
          </Paper>
        </SimpleGrid>
      </Paper>

      {/* Anti-Double-Counting Guardrails */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="xs">
          <Title order={4}>Guardrails & Double-Counting Prevention</Title>
          {entry.guardrail_notes && (
            <div className="callout-note" role="note">
              {entry.guardrail_notes}
            </div>
          )}
          {doc.isTemplate && !entry.guardrail_notes && doc.guardrailDeepDive.length === 0 && (
            <DocText text="" prompt="what overlaps with other templates and how to avoid double counting." />
          )}
          {doc.guardrailDeepDive.length > 0 && (
            <ul className="docs-list">
              {doc.guardrailDeepDive.map((note, idx) => (
                <li key={idx}>{note}</li>
              ))}
            </ul>
          )}
        </Stack>
      </Paper>

      {/* Worked Examples */}
      <Stack gap="sm" style={{ minWidth: 0 }}>
        {doc.examples.length > 0 && <Title order={3}>Worked Examples ({doc.examples.length})</Title>}

        {doc.examples.map((ex, idx) => {
          const computed = computeExampleResult(entry.formula_type, ex);
          return (
            <Paper
              key={ex.id}
              withBorder
              p={{ base: 'sm', sm: 'md' }}
              radius="md"
              bg="var(--bg-surface)"
            >
              <Stack gap="sm" style={{ minWidth: 0 }}>
                <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <Text size="xs" fw={600} c="var(--text-muted)">
                      Example {idx + 1} · {ex.domain} · Stream: {ex.valueStream}
                    </Text>
                    <Title order={4}>{ex.title}</Title>
                  </div>

                  {hasActiveInitiative && onUseTemplate && (
                    <Button
                      type="button"
                      size="xs"
                      variant="default"
                      leftSection={<IconPlus size={13} />}
                      onClick={() =>
                        onUseTemplate({
                          catalog_id: entry.id,
                          label: ex.title,
                          value_stream: ex.valueStream,
                          start_year: ex.startYear,
                          end_year: ex.endYear,
                          ramp_profile: ex.rampProfile,
                          ramp_weights: ex.rampWeights ?? null,
                          param_values: ex.paramValues,
                          uncertainty_spec: ex.uncertaintySpec,
                          anti_double_count_tag: ex.antiDoubleCountTag ?? null,
                        })
                      }
                    >
                      {embedded ? 'Fill Form With Example' : 'Try in Initiative'}
                    </Button>
                  )}
                </Group>

                <Text size="sm" c="var(--text-body)" lh={1.55}>
                  {ex.summary}
                </Text>

                <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                  Schedule: Y{ex.startYear}–Y{ex.endYear} of {ex.horizonYears}-yr horizon · Ramp:{' '}
                  {RAMP_LABELS[ex.rampProfile] || ex.rampProfile}
                  {ex.rampProfile === 'custom_weights' && ex.rampWeights
                    ? ` [${ex.rampWeights.join(', ')}]`
                    : ''}{' '}
                  · Discount rate: {formatPercent(ex.discountRate, 1)}
                </Text>

                {/* Input Parameter Grid */}
                <div>
                  <Text size="xs" fw={600} c="var(--text-muted)" mb={6}>
                    Parameter Inputs
                  </Text>
                  <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} spacing="xs">
                    {entry.parameters.map((param) => {
                      const val = ex.paramValues[param.key] ?? param.default_value;
                      return (
                        <Paper key={param.key} withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                          <Text size="xs" c="var(--text-muted)" lh={1.3}>
                            {param.label}
                          </Text>
                          <Text size="sm" fw={600} c="var(--text-heading)" className="tabular-nums" mt={2}>
                            {val.toLocaleString('en-US')}
                            {param.unit ? ` ${param.unit}` : ''}
                          </Text>
                          <Code
                            mt={2}
                            display="block"
                            style={{
                              background: 'transparent',
                              padding: 0,
                              color: 'var(--text-muted)',
                              fontSize: 11,
                            }}
                          >
                            {param.key}
                          </Code>
                        </Paper>
                      );
                    })}
                  </SimpleGrid>
                </div>

                {/* Calculated Summary Strip */}
                <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
                  <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                    <Text size="xs" c="var(--text-muted)">
                      Base Annual Value (100% ramp)
                    </Text>
                    <Text size="md" fw={700} c="var(--text-heading)" className="tabular-nums">
                      {formatCurrency(computed.baseAnnualValue)} / yr
                    </Text>
                  </Paper>
                  <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                    <Text size="xs" c="var(--text-muted)">
                      Total Undiscounted ({ex.horizonYears} yrs)
                    </Text>
                    <Text size="md" fw={700} c="var(--text-heading)" className="tabular-nums">
                      {formatCurrency(computed.totalUndiscounted)}
                    </Text>
                  </Paper>
                  <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
                    <Text size="xs" c="var(--text-muted)">
                      Total Present Value (PV)
                    </Text>
                    <Text
                      size="md"
                      fw={700}
                      c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                      className="tabular-nums"
                    >
                      {formatCurrency(computed.totalPv)}
                    </Text>
                  </Paper>
                </SimpleGrid>

                {/* Year-by-Year Cash Flow & PV Schedule */}
                <div
                  tabIndex={0}
                  role="region"
                  aria-label={`${ex.title} yearly PV schedule`}
                  className="table-region docs-example-table"
                >
                  <Table verticalSpacing={5} horizontalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Year</Table.Th>
                        <Table.Th ta="right">Ramp</Table.Th>
                        <Table.Th ta="right">Undiscounted</Table.Th>
                        <Table.Th ta="right">Disc. Factor</Table.Th>
                        <Table.Th ta="right">Present Value</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {computed.yearlyRows.map((row) => (
                        <Table.Tr key={row.year}>
                          <Table.Td fw={600} className="tabular-nums">
                            Y{row.year}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {formatPercent(row.rampMultiplier, 0)}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {formatCurrency(row.undiscounted)}
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums">
                            {row.discountFactor.toFixed(4)}
                          </Table.Td>
                          <Table.Td
                            ta="right"
                            fw={row.pv > 0 ? 600 : 400}
                            c={row.pv > 0 ? (isCost ? 'var(--text-neg)' : 'var(--text-pos)') : 'var(--text-muted)'}
                            className="tabular-nums"
                          >
                            {formatCurrency(row.pv)}
                          </Table.Td>
                        </Table.Tr>
                      ))}
                      <Table.Tr style={{ background: 'var(--bg-table-head)' }}>
                        <Table.Td fw={700} c="var(--text-heading)">
                          Total
                        </Table.Td>
                        <Table.Td ta="right" c="var(--text-muted)">
                          —
                        </Table.Td>
                        <Table.Td ta="right" fw={700} className="tabular-nums">
                          {formatCurrency(computed.totalUndiscounted)}
                        </Table.Td>
                        <Table.Td ta="right" c="var(--text-muted)">
                          —
                        </Table.Td>
                        <Table.Td
                          ta="right"
                          fw={700}
                          c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                          className="tabular-nums"
                        >
                          {formatCurrency(computed.totalPv)}
                        </Table.Td>
                      </Table.Tr>
                    </Table.Tbody>
                  </Table>
                </div>

                <Text size="xs" c="var(--text-muted)">
                  <strong>Recommended Monte Carlo setup:</strong> {ex.uncertaintySummary}
                  {ex.antiDoubleCountTag ? ` · Anti-double-count tag: ${ex.antiDoubleCountTag}` : ''}
                </Text>
              </Stack>
            </Paper>
          );
        })}
      </Stack>
    </Stack>
  );
}

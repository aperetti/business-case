import { Fragment, useMemo, useState } from 'react';
import {
  ActionIcon,
  Button,
  Divider,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import type { InitiativeItemOut } from '../types/api';
import { formatCurrency, formatYearRange, summarizeUncertainty } from '../utils/format';

interface Props {
  items: InitiativeItemOut[];
  costStartYear?: number | null;
  onAdd: () => void;
  onAddForCatalog?: (catalogId: string) => void;
  onEdit: (item: InitiativeItemOut) => void;
  onDelete: (item: InitiativeItemOut) => void;
}

interface CatalogGroup {
  catalogId: string;
  catalogName: string;
  kind: 'cost' | 'benefit';
  items: InitiativeItemOut[];
  totalBaseAnnual: number;
  totalPv: number;
  minStartYear: number;
  maxEndYear: number;
  valueStreams: string[];
  rampSummary: string;
  uncertaintySummary: string;
}

const RAMP_LABELS: Record<string, string> = {
  immediate: 'Immediate',
  linear: 'Linear',
  s_curve: 'S-Curve',
  custom_weights: 'Custom',
};

export function LineItemsTable({
  items,
  costStartYear,
  onAdd,
  onAddForCatalog,
  onEdit,
  onDelete,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const groups: CatalogGroup[] = useMemo(() => {
    const map = new Map<string, InitiativeItemOut[]>();
    for (const item of items) {
      const existing = map.get(item.catalog_id);
      if (existing) {
        existing.push(item);
      } else {
        map.set(item.catalog_id, [item]);
      }
    }

    const built: CatalogGroup[] = [];
    for (const [catalogId, groupItems] of map.entries()) {
      const first = groupItems[0];
      const totalBaseAnnual = groupItems.reduce((acc, it) => acc + it.base_annual_value, 0);
      const totalPv = groupItems.reduce((acc, it) => acc + it.pv_total, 0);
      const minStartYear = Math.min(...groupItems.map((it) => it.start_year));
      const maxEndYear = Math.max(...groupItems.map((it) => it.end_year));
      const valueStreams = Array.from(new Set(groupItems.map((it) => it.value_stream)));

      const ramps = Array.from(new Set(groupItems.map((it) => it.ramp_profile)));
      const rampSummary =
        ramps.length === 1 ? RAMP_LABELS[ramps[0]] || ramps[0] : 'Mixed';

      let uncertaintySummary: string;
      if (groupItems.length === 1) {
        uncertaintySummary = summarizeUncertainty(first.uncertainty_spec);
      } else {
        const stochasticCount = groupItems.filter(
          (it) => summarizeUncertainty(it.uncertainty_spec) !== 'Deterministic'
        ).length;
        uncertaintySummary =
          stochasticCount === 0
            ? 'Deterministic'
            : `${stochasticCount}/${groupItems.length} stochastic`;
      }

      built.push({
        catalogId,
        catalogName: first.catalog_name,
        kind: first.kind,
        items: groupItems,
        totalBaseAnnual,
        totalPv,
        minStartYear,
        maxEndYear,
        valueStreams,
        rampSummary,
        uncertaintySummary,
      });
    }

    built.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'cost' ? -1 : 1;
      return b.totalPv - a.totalPv;
    });
    return built;
  }, [items]);

  const anyExpanded = groups.some((g) => expandedGroups[g.catalogId]);

  const toggleGroup = (catalogId: string) => {
    setExpandedGroups((prev) => ({ ...prev, [catalogId]: !prev[catalogId] }));
  };

  const toggleAllGroups = () => {
    if (anyExpanded) {
      setExpandedGroups({});
    } else {
      const next: Record<string, boolean> = {};
      for (const g of groups) next[g.catalogId] = true;
      setExpandedGroups(next);
    }
  };

  return (
    <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
      <Group justify="space-between" align="center" mb="sm" wrap="wrap" gap="xs">
        <div>
          <Title order={5}>
            Catalog Line Items ({groups.length} template{groups.length === 1 ? '' : 's'} ·{' '}
            {items.length} item{items.length === 1 ? '' : 's'})
          </Title>
          <Text size="xs" c="var(--text-muted)">
            Grouped and aggregated by catalog template — expand a caret to inspect or edit individual items
          </Text>
        </div>
        <Group gap="xs" wrap="wrap" grow={isMobile}>
          {groups.length > 0 && (
            <Button type="button" size="sm" variant="subtle" color="gray" onClick={toggleAllGroups}>
              {anyExpanded ? 'Collapse all' : 'Expand all'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="default"
            leftSection={<IconPlus size={15} />}
            onClick={onAdd}
          >
            Add Line Item
          </Button>
        </Group>
      </Group>

      {items.length === 0 ? (
        <Text size="sm" c="var(--text-muted)" py="xl" ta="center">
          No line items added yet. Click &ldquo;Add Line Item&rdquo; to instantiate a cost or benefit template.
        </Text>
      ) : isMobile ? (
        <Stack gap={0}>
          {groups.map((group, gIdx) => {
            const isCost = group.kind === 'cost';
            const isExpanded = Boolean(expandedGroups[group.catalogId]);
            return (
              <Fragment key={group.catalogId}>
                {gIdx > 0 && <Divider color="var(--border-divider)" my="sm" />}
                <Stack gap={8}>
                  <Group
                    justify="space-between"
                    align="flex-start"
                    wrap="nowrap"
                    gap="xs"
                    onClick={() => toggleGroup(group.catalogId)}
                    style={{ cursor: 'pointer' }}
                  >
                    <Group gap={6} align="flex-start" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                      <ActionIcon
                        type="button"
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.catalogId}`}
                        aria-expanded={isExpanded}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroup(group.catalogId);
                        }}
                      >
                        {isExpanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                      </ActionIcon>
                      <div style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="wrap">
                          <span
                            className="status-dot"
                            style={{
                              backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)',
                            }}
                          />
                          <Text size="xs" fw={600} c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}>
                            {isCost ? 'Cost' : 'Benefit'}
                          </Text>
                          <Text size="xs" ff="monospace" fw={600} c="var(--text-muted)">
                            · {group.catalogId}
                          </Text>
                          <Text size="xs" c="var(--text-muted)">
                            · {group.items.length} item{group.items.length === 1 ? '' : 's'}
                          </Text>
                        </Group>
                        <Text size="sm" fw={700} c="var(--text-heading)">
                          {group.catalogName}
                        </Text>
                        <Text size="xs" c="var(--text-muted)">
                          {group.valueStreams.length === 1
                            ? group.valueStreams[0]
                            : `${group.valueStreams.length} streams`}{' '}
                          · {formatYearRange(group.minStartYear, group.maxEndYear, costStartYear)} · {group.rampSummary}
                        </Text>
                      </div>
                    </Group>

                    {onAddForCatalog && (
                      <ActionIcon
                        type="button"
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label={`Add ${group.catalogId} item`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddForCatalog(group.catalogId);
                        }}
                      >
                        <IconPlus size={15} />
                      </ActionIcon>
                    )}
                  </Group>

                  <SimpleGrid cols={2} spacing="xs" pl={30}>
                    <div>
                      <Text size="xs" c="var(--text-muted)">
                        Agg. Base Annual
                      </Text>
                      <Text size="sm" fw={600} className="tabular-nums" c="var(--text-body)">
                        {formatCurrency(group.totalBaseAnnual)}
                      </Text>
                    </div>
                    <div>
                      <Text size="xs" c="var(--text-muted)">
                        Agg. Total PV
                      </Text>
                      <Text
                        size="sm"
                        fw={700}
                        className="tabular-nums"
                        c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                      >
                        {formatCurrency(group.totalPv)}
                      </Text>
                    </div>
                  </SimpleGrid>

                  {isExpanded && (
                    <Stack
                      gap="xs"
                      ml={10}
                      pl={12}
                      style={{ borderInlineStart: '2px solid var(--border-subtle)' }}
                    >
                      {group.items.map((item, iIdx) => (
                        <Fragment key={item.id}>
                          {iIdx > 0 && <Divider color="var(--border-divider)" />}
                          <Stack gap={4}>
                            <Text size="sm" fw={600} c="var(--text-heading)">
                              {item.label}
                            </Text>
                            <Text size="xs" c="var(--text-muted)">
                              {item.value_stream} · {formatYearRange(item.start_year, item.end_year, costStartYear)} ·{' '}
                              {RAMP_LABELS[item.ramp_profile] || item.ramp_profile}
                              {item.anti_double_count_tag ? ` · tag: ${item.anti_double_count_tag}` : ''}
                            </Text>
                            <SimpleGrid cols={2} spacing="xs">
                              <div>
                                <Text size="xs" c="var(--text-muted)">
                                  Base Annual
                                </Text>
                                <Text size="xs" fw={500} className="tabular-nums" c="var(--text-body)">
                                  {formatCurrency(item.base_annual_value)}
                                </Text>
                              </div>
                              <div>
                                <Text size="xs" c="var(--text-muted)">
                                  Item PV
                                </Text>
                                <Text
                                  size="xs"
                                  fw={600}
                                  className="tabular-nums"
                                  c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                                >
                                  {formatCurrency(item.pv_total)}
                                </Text>
                              </div>
                            </SimpleGrid>
                            <Group justify="space-between" align="center" wrap="wrap" gap="xs">
                              <Text size="xs" c="var(--text-muted)" style={{ flex: '1 1 120px' }}>
                                {summarizeUncertainty(item.uncertainty_spec)}
                              </Text>
                              <Group gap="xs">
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="subtle"
                                  color="gray"
                                  leftSection={<IconEdit size={13} />}
                                  onClick={() => onEdit(item)}
                                >
                                  Edit
                                </Button>
                                <Button
                                  type="button"
                                  size="xs"
                                  variant="subtle"
                                  color="gray"
                                  leftSection={<IconTrash size={13} />}
                                  onClick={() => onDelete(item)}
                                >
                                  Delete
                                </Button>
                              </Group>
                            </Group>
                          </Stack>
                        </Fragment>
                      ))}
                    </Stack>
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
          aria-label="Initiative cost and benefit catalog groups"
          className="table-region"
        >
          <Table verticalSpacing="xs" horizontalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Catalog Template / Line Item</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Value Stream</Table.Th>
                <Table.Th>Years</Table.Th>
                <Table.Th>Ramp</Table.Th>
                <Table.Th>Uncertainty</Table.Th>
                <Table.Th ta="right">Base Annual</Table.Th>
                <Table.Th ta="right">Total PV</Table.Th>
                <Table.Th ta="right">Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {groups.map((group) => {
                const isCost = group.kind === 'cost';
                const isExpanded = Boolean(expandedGroups[group.catalogId]);
                return (
                  <Fragment key={group.catalogId}>
                    <Table.Tr
                      className="line-item-group-row"
                      onClick={() => toggleGroup(group.catalogId)}
                    >
                      <Table.Td className="cell-wrap">
                        <Group gap={8} wrap="nowrap" align="flex-start">
                          <ActionIcon
                            type="button"
                            variant="subtle"
                            color="gray"
                            size="sm"
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.catalogId}`}
                            aria-expanded={isExpanded}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroup(group.catalogId);
                            }}
                          >
                            {isExpanded ? <IconChevronDown size={15} /> : <IconChevronRight size={15} />}
                          </ActionIcon>
                          <Stack gap={2} style={{ minWidth: 0 }}>
                            <Text size="sm" fw={700} c="var(--text-heading)">
                              {group.catalogName}
                            </Text>
                            <Text size="xs" c="var(--text-muted)">
                              <Text span ff="monospace" fw={600} c="var(--text-body)">
                                {group.catalogId}
                              </Text>{' '}
                              · {group.items.length} item{group.items.length === 1 ? '' : 's'}
                            </Text>
                          </Stack>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap">
                          <span
                            className="status-dot"
                            style={{
                              backgroundColor: isCost ? 'var(--chart-neg)' : 'var(--chart-pos)',
                            }}
                          />
                          <Text size="xs" fw={600} c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}>
                            {isCost ? 'Cost' : 'Benefit'}
                          </Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" fw={500} c="var(--text-body)">
                          {group.valueStreams.length === 1
                            ? group.valueStreams[0]
                            : `${group.valueStreams.length} streams`}
                        </Text>
                      </Table.Td>
                      <Table.Td className="tabular-nums">
                        {formatYearRange(group.minStartYear, group.maxEndYear, costStartYear)}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="var(--text-muted)">
                          {group.rampSummary}
                        </Text>
                      </Table.Td>
                      <Table.Td className="cell-wrap">
                        <Text size="xs" c="var(--text-muted)">
                          {group.uncertaintySummary}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right" className="tabular-nums" fw={700} c="var(--text-heading)">
                        {formatCurrency(group.totalBaseAnnual)}
                      </Table.Td>
                      <Table.Td
                        ta="right"
                        className="tabular-nums"
                        fw={700}
                        c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                      >
                        {formatCurrency(group.totalPv)}
                      </Table.Td>
                      <Table.Td ta="right">
                        {onAddForCatalog && (
                          <ActionIcon
                            type="button"
                            variant="subtle"
                            color="gray"
                            aria-label={`Add item using ${group.catalogId}`}
                            title={`Add item using ${group.catalogId}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onAddForCatalog(group.catalogId);
                            }}
                          >
                            <IconPlus size={15} />
                          </ActionIcon>
                        )}
                      </Table.Td>
                    </Table.Tr>

                    {isExpanded &&
                      group.items.map((item) => (
                        <Table.Tr key={item.id} className="line-item-child-row">
                          <Table.Td className="cell-wrap line-item-child-indent">
                            <Stack gap={2}>
                              <Text size="sm" fw={500} c="var(--text-heading)">
                                {item.label}
                              </Text>
                              {item.anti_double_count_tag && (
                                <Text size="xs" c="var(--text-muted)">
                                  tag: {item.anti_double_count_tag}
                                </Text>
                              )}
                            </Stack>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="var(--text-muted)">
                              Detail
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="var(--text-body)">
                              {item.value_stream}
                            </Text>
                          </Table.Td>
                          <Table.Td className="tabular-nums">
                            {formatYearRange(item.start_year, item.end_year, costStartYear)}
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c="var(--text-muted)">
                              {RAMP_LABELS[item.ramp_profile] || item.ramp_profile}
                            </Text>
                          </Table.Td>
                          <Table.Td className="cell-wrap">
                            <Text size="xs" c="var(--text-muted)">
                              {summarizeUncertainty(item.uncertainty_spec)}
                            </Text>
                          </Table.Td>
                          <Table.Td ta="right" className="tabular-nums" c="var(--text-body)">
                            {formatCurrency(item.base_annual_value)}
                          </Table.Td>
                          <Table.Td
                            ta="right"
                            className="tabular-nums"
                            fw={600}
                            c={isCost ? 'var(--text-neg)' : 'var(--text-pos)'}
                          >
                            {formatCurrency(item.pv_total)}
                          </Table.Td>
                          <Table.Td>
                            <Group gap={4} justify="flex-end" wrap="nowrap">
                              <ActionIcon
                                type="button"
                                variant="subtle"
                                color="gray"
                                aria-label={`Edit ${item.label}`}
                                onClick={() => onEdit(item)}
                              >
                                <IconEdit size={15} />
                              </ActionIcon>
                              <ActionIcon
                                type="button"
                                variant="subtle"
                                color="gray"
                                aria-label={`Delete ${item.label}`}
                                onClick={() => onDelete(item)}
                              >
                                <IconTrash size={15} />
                              </ActionIcon>
                            </Group>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                  </Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Paper>
  );
}

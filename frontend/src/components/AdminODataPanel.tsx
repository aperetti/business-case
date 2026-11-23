import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconCheck,
  IconCopy,
  IconDatabaseExport,
  IconExternalLink,
  IconKey,
  IconPlayerPlay,
  IconRefresh,
} from '@tabler/icons-react';
import { api } from '../api/client';
import type { ODataPreviewResponse, ODataStatusOut } from '../types/api';

interface Props {
  onGoToApiKeys: () => void;
}

const CODE_BLOCK_STYLE: React.CSSProperties = {
  background: 'var(--bg-subtle)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-body)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
};

const QUERY_PRESETS: Array<{
  label: string;
  entity_set: string;
  filter: string;
  select: string;
  orderby: string;
  expand: string;
  top: number;
}> = [
  {
    label: 'Initiatives + Items',
    entity_set: 'Initiatives',
    filter: '',
    select: 'Id,Name,Domain,CostStartYear,PvCosts,PvBenefits,Npv,Bcr',
    orderby: 'Npv desc',
    expand: 'CostBenefitItems($select=Label,Kind,ValueStream,PvTotal;$orderby=PvTotal desc)',
    top: 10,
  },
  {
    label: 'Benefits Only',
    entity_set: 'CostBenefitItems',
    filter: "Kind eq 'benefit'",
    select: 'InitiativeName,CatalogId,Label,ValueStream,StartYear,EndYear,BaseAnnualValue,PvTotal',
    orderby: 'PvTotal desc',
    expand: '',
    top: 25,
  },
  {
    label: 'Costs Only',
    entity_set: 'CostBenefitItems',
    filter: "Kind eq 'cost'",
    select: 'InitiativeName,CatalogId,Label,ValueStream,StartYear,EndYear,BaseAnnualValue,PvTotal',
    orderby: 'PvTotal desc',
    expand: '',
    top: 25,
  },
  {
    label: 'Annual Cash Flows',
    entity_set: 'YearlyCashFlows',
    filter: '',
    select: 'InitiativeName,Year,CalendarYear,UndiscountedCost,UndiscountedBenefit,PvCost,PvBenefit,NetPv,CumulativeNetPv',
    orderby: 'InitiativeName asc, Year asc',
    expand: '',
    top: 30,
  },
  {
    label: 'Value Streams',
    entity_set: 'ValueStreams',
    filter: '',
    select: 'InitiativeName,ValueStream,ItemCount,PvCosts,PvBenefits,Npv,Bcr',
    orderby: 'Npv desc',
    expand: '',
    top: 25,
  },
];

function formatCellValue(val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') {
    if (Math.abs(val) >= 1000 && Number.isInteger(val)) return val.toLocaleString('en-US');
    if (Math.abs(val) >= 100) {
      return val.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return Number.isInteger(val) ? String(val) : val.toFixed(3);
  }
  if (Array.isArray(val)) return `[${val.length} rows]`;
  if (typeof val === 'object') return '{object}';
  const text = String(val);
  return text.length > 72 ? `${text.slice(0, 69)}...` : text;
}

export function AdminODataPanel({ onGoToApiKeys }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [statusData, setStatusData] = useState<ODataStatusOut | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [entitySet, setEntitySet] = useState('Initiatives');
  const [filterExpr, setFilterExpr] = useState('');
  const [selectExpr, setSelectExpr] = useState('Id,Name,Domain,CostStartYear,PvCosts,PvBenefits,Npv,Bcr');
  const [orderbyExpr, setOrderbyExpr] = useState('Npv desc');
  const [expandExpr, setExpandExpr] = useState('');
  const [topVal, setTopVal] = useState<number>(25);
  const [includeCount, setIncludeCount] = useState(true);

  const [previewResult, setPreviewResult] = useState<ODataPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [runningPreview, setRunningPreview] = useState(false);
  const [resultView, setResultView] = useState<'table' | 'json'>('table');
  const [connectorTab, setConnectorTab] = useState<'powerbi' | 'm' | 'curl'>('powerbi');

  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
  const serviceRootUrl = `${origin}${statusData?.service_root_path || '/odata/v4'}`;
  const metadataUrl = `${origin}${statusData?.metadata_path || '/odata/v4/$metadata'}`;

  const runPreview = useCallback(
    async (override?: Partial<{
      entity_set: string;
      filter: string;
      select: string;
      orderby: string;
      expand: string;
      top: number;
      count: boolean;
    }>) => {
      const targetEntity = override?.entity_set ?? entitySet;
      const targetFilter = override?.filter ?? filterExpr;
      const targetSelect = override?.select ?? selectExpr;
      const targetOrderby = override?.orderby ?? orderbyExpr;
      const targetExpand = override?.expand ?? expandExpr;
      const targetTop = override?.top ?? topVal;
      const targetCount = override?.count ?? includeCount;

      setRunningPreview(true);
      setPreviewError(null);
      try {
        const res = await api.previewOData({
          entity_set: targetEntity,
          filter: targetFilter,
          select: targetSelect,
          orderby: targetOrderby,
          expand: targetExpand,
          top: targetTop,
          count: targetCount,
        });
        setPreviewResult(res);
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : 'Failed to run OData query.');
      } finally {
        setRunningPreview(false);
      }
    },
    [entitySet, filterExpr, selectExpr, orderbyExpr, expandExpr, topVal, includeCount]
  );

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const s = await api.getODataStatus();
      setStatusData(s);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to load OData feed status.');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    runPreview({
      entity_set: 'Initiatives',
      filter: '',
      select: 'Id,Name,Domain,CostStartYear,PvCosts,PvBenefits,Npv,Bcr',
      orderby: 'Npv desc',
      expand: '',
      top: 25,
      count: true,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const builtQueryUrl = useMemo(() => {
    const qs = new URLSearchParams();
    if (filterExpr.trim()) qs.set('$filter', filterExpr.trim());
    if (selectExpr.trim()) qs.set('$select', selectExpr.trim());
    if (orderbyExpr.trim()) qs.set('$orderby', orderbyExpr.trim());
    if (expandExpr.trim()) qs.set('$expand', expandExpr.trim());
    if (topVal > 0) qs.set('$top', String(topVal));
    if (includeCount) qs.set('$count', 'true');
    const q = qs.toString();
    return `${serviceRootUrl}/${entitySet}${q ? `?${q}` : ''}`;
  }, [serviceRootUrl, entitySet, filterExpr, selectExpr, orderbyExpr, expandExpr, topVal, includeCount]);

  const tableColumns = useMemo(() => {
    const rows = previewResult?.value || [];
    if (rows.length === 0) return [];
    return Object.keys(rows[0]).filter((k) => !k.startsWith('@odata.'));
  }, [previewResult]);

  const entityOptions = useMemo(() => {
    const defs = statusData?.entity_sets || [];
    if (defs.length === 0) {
      return [
        'Initiatives',
        'CostBenefitItems',
        'YearlyCashFlows',
        'ValueStreams',
        'CatalogEntries',
        'SimulationRuns',
      ].map((v) => ({ value: v, label: v }));
    }
    return defs.map((d) => ({
      value: d.name,
      label: `${d.name} (${d.row_count})`,
    }));
  }, [statusData]);

  const applyPreset = (preset: (typeof QUERY_PRESETS)[number]) => {
    setEntitySet(preset.entity_set);
    setFilterExpr(preset.filter);
    setSelectExpr(preset.select);
    setOrderbyExpr(preset.orderby);
    setExpandExpr(preset.expand);
    setTopVal(preset.top);
    runPreview({
      entity_set: preset.entity_set,
      filter: preset.filter,
      select: preset.select,
      orderby: preset.orderby,
      expand: preset.expand,
      top: preset.top,
      count: includeCount,
    });
  };

  const quickSelectEntity = (name: string) => {
    setEntitySet(name);
    setFilterExpr('');
    setSelectExpr('');
    setOrderbyExpr('');
    setExpandExpr('');
    runPreview({
      entity_set: name,
      filter: '',
      select: '',
      orderby: '',
      expand: '',
      top: topVal,
      count: includeCount,
    });
  };

  const powerQuerySnippet = `let
    Source = OData.Feed("${serviceRootUrl}", null, [Implementation="2.0"]),
    Initiatives = Source{[Name="Initiatives",Signature="table"]}[Data],
    CostBenefitItems = Source{[Name="CostBenefitItems",Signature="table"]}[Data],
    YearlyCashFlows = Source{[Name="YearlyCashFlows",Signature="table"]}[Data]
in
    CostBenefitItems`;

  const curlSnippet = `curl "${builtQueryUrl}"${
    statusData?.auth_mode === 'api_key_required' ? ' \\\n  -H "Authorization: Bearer YOUR_BCA_KEY"' : ''
  }`;

  return (
    <Stack gap="md">
      {/* Section Header & Feed Endpoints */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="sm">
          <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
            <div>
              <Group gap={8}>
                <IconDatabaseExport size={18} color="var(--accent-primary)" />
                <Title order={4}>OData v4 Analytics &amp; BI Integration</Title>
              </Group>
              <Text size="xs" c="var(--text-muted)" mt={2}>
                OASIS OData v4.0 read-only feed exposing initiatives, cost/benefit line items, yearly cash flows, value streams, catalog templates, and Monte Carlo runs.
              </Text>
            </div>
            <Button
              type="button"
              size="xs"
              variant="default"
              loading={loadingStatus}
              leftSection={<IconRefresh size={13} />}
              onClick={loadStatus}
            >
              Refresh Counts
            </Button>
          </Group>

          {statusError && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{statusError}</Text>
            </Alert>
          )}

          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="xs">
            <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
              <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                OData v4 Service Root URL (Power BI / Excel)
              </Text>
              <Group gap="xs" wrap="nowrap" align="center">
                <Code
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-heading)',
                    border: '1px solid var(--border-subtle)',
                    padding: '4px 8px',
                  }}
                >
                  {serviceRootUrl}
                </Code>
                <CopyButton value={serviceRootUrl}>
                  {({ copied, copy }) => (
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="default"
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
                <Button
                  component="a"
                  href={serviceRootUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconExternalLink size={12} />}
                >
                  Open
                </Button>
              </Group>
            </Paper>

            <Paper withBorder p="xs" radius="sm" bg="var(--bg-subtle)">
              <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                CSDL Schema Metadata ($metadata)
              </Text>
              <Group gap="xs" wrap="nowrap" align="center">
                <Code
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    background: 'var(--bg-surface)',
                    color: 'var(--text-heading)',
                    border: '1px solid var(--border-subtle)',
                    padding: '4px 8px',
                  }}
                >
                  {metadataUrl}
                </Code>
                <CopyButton value={metadataUrl}>
                  {({ copied, copy }) => (
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="default"
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  )}
                </CopyButton>
                <Button
                  component="a"
                  href={metadataUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  size="compact-xs"
                  variant="subtle"
                  color="gray"
                  leftSection={<IconExternalLink size={12} />}
                >
                  XML
                </Button>
              </Group>
            </Paper>
          </SimpleGrid>

          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <Group gap={8} wrap="wrap">
              <span
                className="status-dot"
                style={{
                  backgroundColor:
                    statusData?.auth_mode === 'api_key_required'
                      ? 'var(--chart-pos)'
                      : 'var(--chart-line)',
                }}
              />
              <Text size="xs" c="var(--text-body)">
                {statusData?.auth_mode === 'api_key_required' && statusData.inbound_key_count === 0
                  ? 'API Key Required (SSO is enforced). No keys issued yet: issue one in Gateway & API Keys to grant BI and gateway access.'
                  : statusData?.auth_mode === 'api_key_required'
                  ? `API Key Authentication Enforced (${statusData.inbound_key_count} active key${
                      statusData.inbound_key_count === 1 ? '' : 's'
                    }) — accepts Bearer, Basic (key as username or password), or X-API-Key.`
                  : 'Open LAN / Local Access (0 inbound API keys issued). Issue a key in Gateway & API Keys to require authentication.'}
              </Text>
            </Group>
            <Button
              type="button"
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={<IconKey size={13} />}
              onClick={onGoToApiKeys}
            >
              Manage API Keys
            </Button>
          </Group>
        </Stack>
      </Paper>

      {/* Exposed Entity Sets */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="xs">
          <div>
            <Title order={5}>Exposed OData Entity Sets</Title>
            <Text size="xs" c="var(--text-muted)">
              Click Query on any entity set to preview live rows or copy its direct extraction URL
            </Text>
          </div>

          {isMobile ? (
            <Stack gap={0}>
              {(statusData?.entity_sets || []).map((es, idx) => {
                const esUrl = `${serviceRootUrl}/${es.name}`;
                return (
                  <Fragment key={es.name}>
                    {idx > 0 && <Divider color="var(--border-divider)" my="xs" />}
                    <Stack gap={4}>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <Text size="sm" fw={700} c="var(--text-heading)">
                          {es.name}
                        </Text>
                        <Text size="xs" fw={600} className="tabular-nums" c="var(--text-body)">
                          {es.row_count} rows
                        </Text>
                      </Group>
                      <Text size="xs" c="var(--text-muted)">
                        {es.description}
                      </Text>
                      <Group gap="xs" mt={2}>
                        <Button
                          type="button"
                          size="compact-xs"
                          variant="default"
                          onClick={() => quickSelectEntity(es.name)}
                        >
                          Query
                        </Button>
                        <CopyButton value={esUrl}>
                          {({ copied, copy }) => (
                            <Button
                              type="button"
                              size="compact-xs"
                              variant="subtle"
                              color="gray"
                              onClick={copy}
                            >
                              {copied ? 'Copied URL' : 'Copy URL'}
                            </Button>
                          )}
                        </CopyButton>
                      </Group>
                    </Stack>
                  </Fragment>
                );
              })}
            </Stack>
          ) : (
            <div tabIndex={0} role="region" aria-label="OData entity sets" className="table-region">
              <Table verticalSpacing={6} horizontalSpacing="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Entity Set</Table.Th>
                    <Table.Th ta="right">Rows</Table.Th>
                    <Table.Th>Navigation Properties</Table.Th>
                    <Table.Th>Description</Table.Th>
                    <Table.Th ta="right">Actions</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {(statusData?.entity_sets || []).map((es) => {
                    const esUrl = `${serviceRootUrl}/${es.name}`;
                    return (
                      <Table.Tr key={es.name}>
                        <Table.Td fw={700} c="var(--text-heading)">
                          {es.name}
                        </Table.Td>
                        <Table.Td ta="right" className="tabular-nums" fw={600}>
                          {es.row_count}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" ff="monospace" c="var(--text-muted)">
                            {es.navigation_properties.length > 0
                              ? es.navigation_properties.join(', ')
                              : '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td className="cell-wrap">
                          <Text size="xs" c="var(--text-body)">
                            {es.description}
                          </Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <Button
                              type="button"
                              size="compact-xs"
                              variant="default"
                              onClick={() => quickSelectEntity(es.name)}
                            >
                              Query
                            </Button>
                            <CopyButton value={esUrl}>
                              {({ copied, copy }) => (
                                <Button
                                  type="button"
                                  size="compact-xs"
                                  variant="subtle"
                                  color="gray"
                                  onClick={copy}
                                >
                                  {copied ? 'Copied' : 'URL'}
                                </Button>
                              )}
                            </CopyButton>
                          </Group>
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

      {/* Interactive OData Query Explorer */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="sm">
          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <div>
              <Title order={5}>Interactive OData Query Explorer</Title>
              <Text size="xs" c="var(--text-muted)">
                Test $filter, $select, $orderby, and $expand queries live against the database
              </Text>
            </div>
            <Group gap={6} wrap="wrap">
              {QUERY_PRESETS.map((p) => (
                <Button
                  key={p.label}
                  type="button"
                  size="compact-xs"
                  variant="default"
                  onClick={() => applyPreset(p)}
                >
                  {p.label}
                </Button>
              ))}
            </Group>
          </Group>

          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="xs">
            <Select
              label="Entity Set"
              data={entityOptions}
              value={entitySet}
              onChange={(v) => setEntitySet(v || 'Initiatives')}
              allowDeselect={false}
            />
            <TextInput
              label="$filter"
              placeholder="e.g. Kind eq 'benefit' and PvTotal gt 100000"
              value={filterExpr}
              onChange={(e) => setFilterExpr(e.currentTarget.value)}
            />
            <TextInput
              label="$orderby"
              placeholder="e.g. Npv desc"
              value={orderbyExpr}
              onChange={(e) => setOrderbyExpr(e.currentTarget.value)}
            />
            <NumberInput
              label="$top"
              min={1}
              max={200}
              allowDecimal={false}
              allowNegative={false}
              value={topVal}
              onChange={(v) => setTopVal(typeof v === 'number' && v >= 1 ? v : 25)}
            />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xs">
            <TextInput
              label="$select (comma-separated fields)"
              placeholder="Leave empty for all properties"
              value={selectExpr}
              onChange={(e) => setSelectExpr(e.currentTarget.value)}
            />
            <TextInput
              label="$expand (navigation properties)"
              placeholder="e.g. CostBenefitItems($select=Label,Kind,PvTotal)"
              value={expandExpr}
              onChange={(e) => setExpandExpr(e.currentTarget.value)}
            />
          </SimpleGrid>

          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <Switch
              label="Include @odata.count ($count=true)"
              checked={includeCount}
              onChange={(e) => setIncludeCount(e.currentTarget.checked)}
              size="xs"
            />
            <Group gap="xs" wrap="wrap" grow={isMobile} w={{ base: '100%', sm: 'auto' }}>
              <SegmentedControl
                size="xs"
                value={resultView}
                onChange={(v) => setResultView(v as 'table' | 'json')}
                data={[
                  { label: 'Table', value: 'table' },
                  { label: 'JSON', value: 'json' },
                ]}
              />
              <Button
                type="button"
                size="xs"
                loading={runningPreview}
                leftSection={<IconPlayerPlay size={13} />}
                onClick={() => runPreview()}
              >
                Run Query
              </Button>
            </Group>
          </Group>

          <Group gap="xs" wrap="nowrap" align="center">
            <Code
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                background: 'var(--bg-subtle)',
                color: 'var(--text-body)',
                border: '1px solid var(--border-subtle)',
                padding: '5px 8px',
              }}
            >
              {builtQueryUrl}
            </Code>
            <CopyButton value={builtQueryUrl}>
              {({ copied, copy }) => (
                <Button
                  type="button"
                  size="compact-xs"
                  variant="default"
                  leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                  onClick={copy}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
            </CopyButton>
          </Group>

          {previewError && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{previewError}</Text>
            </Alert>
          )}

          {previewResult && (
            <Stack gap="xs">
              <Text size="xs" c="var(--text-muted)" className="tabular-nums">
                Returned {previewResult.value.length} row{previewResult.value.length === 1 ? '' : 's'}
                {previewResult['@odata.count'] !== undefined
                  ? ` (total matching $count: ${previewResult['@odata.count']})`
                  : ''}
              </Text>

              {resultView === 'table' ? (
                previewResult.value.length === 0 ? (
                  <Text size="xs" c="var(--text-muted)" py="md" ta="center">
                    No entities matched the current query filters.
                  </Text>
                ) : (
                  <div
                    tabIndex={0}
                    role="region"
                    aria-label="OData preview table"
                    className="table-region"
                  >
                    <Table verticalSpacing={6} horizontalSpacing="xs">
                      <Table.Thead>
                        <Table.Tr>
                          {tableColumns.map((col) => (
                            <Table.Th key={col}>{col}</Table.Th>
                          ))}
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {previewResult.value.map((row, idx) => (
                          <Table.Tr key={String(row.Id ?? idx)}>
                            {tableColumns.map((col) => (
                              <Table.Td key={col} className="tabular-nums">
                                {formatCellValue(row[col])}
                              </Table.Td>
                            ))}
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </div>
                )
              ) : (
                <Code
                  block
                  style={{
                    ...CODE_BLOCK_STYLE,
                    maxHeight: 340,
                    overflowY: 'auto',
                  }}
                >
                  {JSON.stringify(previewResult, null, 2)}
                </Code>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>

      {/* BI Connector Snippets */}
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Stack gap="sm">
          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <div>
              <Title order={5}>Connecting Power BI, Excel &amp; REST Clients</Title>
              <Text size="xs" c="var(--text-muted)">
                Ready-to-paste connection instructions for BI analytics teams
              </Text>
            </div>
            <SegmentedControl
              size="xs"
              value={connectorTab}
              onChange={(v) => setConnectorTab(v as 'powerbi' | 'm' | 'curl')}
              data={[
                { label: 'Power BI / Excel', value: 'powerbi' },
                { label: 'Power Query (M)', value: 'm' },
                { label: 'cURL', value: 'curl' },
              ]}
            />
          </Group>

          {connectorTab === 'powerbi' && (
            <Stack gap="xs">
              <ul className="docs-list">
                <li>
                  In <strong>Power BI Desktop</strong> or <strong>Excel</strong>: select{' '}
                  <Code>Get Data → From Other Sources → From OData Feed</Code>.
                </li>
                <li>
                  Paste the Service Root URL <Code>{serviceRootUrl}</Code> (or directly target{' '}
                  <Code>{serviceRootUrl}/CostBenefitItems</Code>).
                </li>
                <li>
                  Authentication: choose <strong>Anonymous</strong> when 0 inbound keys are configured, or{' '}
                  <strong>Basic</strong> and enter your ValueStream BCA API key as either User name or Password when keys are active.
                </li>
                <li>
                  Select <Code>Initiatives</Code>, <Code>CostBenefitItems</Code>,{' '}
                  <Code>YearlyCashFlows</Code>, and <Code>ValueStreams</Code> together — relationships auto-detect on <Code>InitiativeId</Code>.
                </li>
              </ul>
            </Stack>
          )}

          {connectorTab === 'm' && (
            <Stack gap="xs">
              <Group justify="flex-end">
                <CopyButton value={powerQuerySnippet}>
                  {({ copied, copy }) => (
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="default"
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied M Script' : 'Copy M Script'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Code block style={CODE_BLOCK_STYLE}>
                {powerQuerySnippet}
              </Code>
            </Stack>
          )}

          {connectorTab === 'curl' && (
            <Stack gap="xs">
              <Group justify="flex-end">
                <CopyButton value={curlSnippet}>
                  {({ copied, copy }) => (
                    <Button
                      type="button"
                      size="compact-xs"
                      variant="default"
                      leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                      onClick={copy}
                    >
                      {copied ? 'Copied cURL' : 'Copy cURL'}
                    </Button>
                  )}
                </CopyButton>
              </Group>
              <Code block style={CODE_BLOCK_STYLE}>
                {curlSnippet}
              </Code>
            </Stack>
          )}
        </Stack>
      </Paper>
    </Stack>
  );
}

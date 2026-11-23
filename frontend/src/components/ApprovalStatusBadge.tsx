import { Badge } from '@mantine/core';
import type { InitiativeStatus } from '../types/api';

export const STATUS_META: Record<InitiativeStatus, { label: string; color: string }> = {
  draft: { label: 'Draft', color: 'gray' },
  in_review: { label: 'In Review', color: 'yellow' },
  approved: { label: 'Approved', color: 'teal' },
  rejected: { label: 'Rejected', color: 'red' },
};

export function ApprovalStatusBadge({
  status,
  size = 'sm',
}: {
  status: InitiativeStatus | undefined;
  size?: 'xs' | 'sm' | 'md';
}) {
  const meta = STATUS_META[status ?? 'draft'];
  return (
    <Badge size={size} variant="light" color={meta.color} style={{ flexShrink: 0 }}>
      {meta.label}
    </Badge>
  );
}

import { createContext, useContext, type ReactNode } from 'react';
import { ActionIcon, Anchor, Button, Popover, Stack, Text } from '@mantine/core';
import { IconBook, IconExternalLink, IconInfoCircle } from '@tabler/icons-react';
import { FIELD_DOCS, FIELD_REFERENCE_SLUG, fieldAnchorId, type FieldKey } from '../data/fieldDocs';

/**
 * Where a field's "Read more" link goes. By default it opens the Field Reference in a new
 * tab so an unsaved form isn't lost; a container (like the line item drawer) can provide a
 * handler that shows the docs in place instead.
 */
export const FieldDocNavigationContext = createContext<((route: string) => void) | null>(null);

export function fieldDocRoute(field: FieldKey): string {
  return `${FIELD_REFERENCE_SLUG}#${fieldAnchorId(field)}`;
}

export interface CustomFieldDoc {
  label: string;
  help: string;
  /** Docs route to open, e.g. a catalog template id. */
  route: string;
}

export function FieldInfo({ field, custom }: { field?: FieldKey; custom?: CustomFieldDoc }) {
  const navigate = useContext(FieldDocNavigationContext);
  const doc = custom ?? (field ? FIELD_DOCS[field] : null);
  if (!doc) return null;
  const route = custom ? custom.route : fieldDocRoute(field as FieldKey);

  return (
    <Popover width={300} position="top-start" withArrow shadow="md" withinPortal>
      <Popover.Target>
        <ActionIcon
          component="span"
          role="button"
          tabIndex={0}
          variant="transparent"
          color="gray"
          size={16}
          aria-label={`About ${doc.label}`}
          // Keep clicks on the icon from focusing or toggling the labelled input.
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
          style={{ verticalAlign: 'middle' }}
        >
          <IconInfoCircle size={14} color="var(--text-muted)" />
        </ActionIcon>
      </Popover.Target>
      <Popover.Dropdown onClick={(e) => e.stopPropagation()}>
        <Stack gap={6}>
          <Text size="sm" fw={600} c="var(--text-heading)">
            {doc.label}
          </Text>
          <Text size="xs" c="var(--text-body)" lh={1.5}>
            {doc.help}
          </Text>
          {navigate ? (
            <Button
              type="button"
              size="compact-xs"
              variant="subtle"
              px={0}
              w="fit-content"
              leftSection={<IconBook size={12} />}
              onClick={() => navigate(route)}
            >
              Read more in the docs
            </Button>
          ) : (
            <Anchor
              size="xs"
              href={`#docs/${encodeURIComponent(route)}`}
              target="_blank"
              rel="noopener"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              Read more in the docs <IconExternalLink size={12} />
            </Anchor>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Input label text followed by the field's info tag. Use as a Mantine `label` prop. */
export function FieldLabel({
  field,
  custom,
  children,
}: {
  field?: FieldKey;
  custom?: CustomFieldDoc;
  children?: ReactNode;
}) {
  return (
    <span className="field-label">
      {children ?? custom?.label ?? (field ? FIELD_DOCS[field].label : '')}
      <FieldInfo field={field} custom={custom} />
    </span>
  );
}

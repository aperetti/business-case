import { Button, Divider, Stack, Text } from '@mantine/core';
import {
  IconArrowLeft,
  IconDatabaseExport,
  IconFingerprint,
  IconKey,
  IconShieldLock,
  IconSparkles,
  IconUsers,
} from '@tabler/icons-react';
import type { AdminSection } from '../types/api';

interface Props {
  activeSection: AdminSection;
  onSelectSection: (section: AdminSection) => void;
  onExitAdmin: () => void;
}

const NAV_GROUPS: {
  label: string;
  items: { id: AdminSection; label: string; icon: React.ComponentType<{ size?: number | string }> }[];
}[] = [
  {
    label: 'Access & Identity',
    items: [
      { id: 'users', label: 'Users', icon: IconUsers },
      { id: 'roles', label: 'Roles & Permissions', icon: IconShieldLock },
      { id: 'sso', label: 'Single Sign-On', icon: IconFingerprint },
    ],
  },
  {
    label: 'Intelligence & Data Feeds',
    items: [
      { id: 'ai', label: 'AI & Models', icon: IconSparkles },
      { id: 'api-keys', label: 'Gateway & API Keys', icon: IconKey },
      { id: 'odata', label: 'OData Data Feed', icon: IconDatabaseExport },
    ],
  },
];

export function AdminSidebar({ activeSection, onSelectSection, onExitAdmin }: Props) {
  return (
    <Stack gap="sm" h="100%">
      <Button
        type="button"
        variant="default"
        size="xs"
        fullWidth
        leftSection={<IconArrowLeft size={14} />}
        onClick={onExitAdmin}
      >
        Back to Workspace
      </Button>

      <Divider color="var(--border-divider)" />

      <div>
        <Text size="sm" fw={700} c="var(--text-heading)">
          Admin Portal
        </Text>
        <Text size="xs" c="var(--text-muted)">
          Platform governance & configuration
        </Text>
      </div>

      <Stack gap="md">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <Text
              size="xs"
              fw={700}
              tt="uppercase"
              c="var(--text-muted)"
              px={8}
              mb={4}
              style={{ letterSpacing: '0.04em', fontSize: 11 }}
            >
              {group.label}
            </Text>
            <Stack gap={2}>
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.id === activeSection;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="docs-nav-item"
                    data-active={isActive ? 'true' : 'false'}
                    onClick={() => onSelectSection(item.id)}
                  >
                    <Icon size={15} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </Stack>
          </div>
        ))}
      </Stack>
    </Stack>
  );
}

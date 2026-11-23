import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { api } from '../api/client';
import type { PermissionKey, RoleOut } from '../types/api';

const WORKSPACE_PERMISSIONS: { key: PermissionKey; label: string }[] = [
  { key: 'initiatives:read', label: 'View Initiatives & Reports' },
  { key: 'initiatives:write', label: 'Create & Edit Initiatives / Items' },
  { key: 'simulations:run', label: 'Run Monte Carlo Simulations' },
  { key: 'catalog:manage', label: 'Manage Custom Catalog Templates' },
  { key: 'docs:ask', label: 'Use Docs Agent Assistant' },
];

const ADMIN_PERMISSIONS: { key: PermissionKey; label: string }[] = [
  { key: 'admin:users', label: 'Manage Users' },
  { key: 'admin:roles', label: 'Manage Roles & Permissions' },
  { key: 'admin:ai', label: 'Configure AI Provider & Gateway Keys' },
  { key: 'admin:sso', label: 'Configure Single Sign-On (Firebase / Entra)' },
  { key: 'admin:workflows', label: 'Manage Approval Workflows & Email' },
];

const PERM_LABEL_BY_KEY: Record<PermissionKey, string> = Object.fromEntries(
  [...WORKSPACE_PERMISSIONS, ...ADMIN_PERMISSIONS].map((p) => [p.key, p.label])
) as Record<PermissionKey, string>;

export function AdminRolesPanel() {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [roles, setRoles] = useState<RoleOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [opened, { open, close }] = useDisclosure(false);
  const [editingRole, setEditingRole] = useState<RoleOut | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissions, setPermissions] = useState<PermissionKey[]>(['initiatives:read', 'docs:ask']);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRoles(await api.listRoles());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load roles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const openCreateModal = () => {
    setEditingRole(null);
    setName('');
    setDescription('');
    setPermissions(['initiatives:read', 'docs:ask']);
    setFormError(null);
    open();
  };

  const openEditModal = (role: RoleOut) => {
    setEditingRole(role);
    setName(role.name);
    setDescription(role.description);
    setPermissions([...role.permissions]);
    setFormError(null);
    open();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError('Role name is required.');
      return;
    }
    if (permissions.length === 0) {
      setFormError('Select at least one permission.');
      return;
    }

    setSaving(true);
    try {
      if (editingRole) {
        await api.updateRole(editingRole.id, {
          name: name.trim(),
          description: description.trim(),
          permissions,
        });
        notifications.show({
          color: 'teal',
          title: 'Role updated',
          message: name.trim(),
        });
      } else {
        await api.createRole({
          name: name.trim(),
          description: description.trim(),
          permissions,
        });
        notifications.show({
          color: 'teal',
          title: 'Role created',
          message: name.trim(),
        });
      }
      close();
      await loadRoles();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save role.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (role: RoleOut) => {
    try {
      await api.deleteRole(role.id);
      await loadRoles();
      notifications.show({
        color: 'gray',
        title: 'Role deleted',
        message: role.name,
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot delete role',
        message: err instanceof Error ? err.message : 'Delete failed',
      });
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" align="center" wrap="wrap" gap="xs">
          <div>
            <Title order={4}>Role Management ({roles.length})</Title>
            <Text size="xs" c="var(--text-muted)">
              Define fine-grained RBAC roles across workspace modeling and platform administration
            </Text>
          </div>
          <Button
            type="button"
            size="sm"
            variant="default"
            fullWidth={isMobile}
            leftSection={<IconPlus size={15} />}
            onClick={openCreateModal}
          >
            New Role
          </Button>
        </Group>
      </Paper>

      {loadError && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
          {loadError}
        </Alert>
      )}

      {loading && roles.length === 0 ? (
        <Paper withBorder p="md" bg="var(--bg-surface)">
          <Text size="sm" c="var(--text-muted)" ta="center">
            Loading roles...
          </Text>
        </Paper>
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          {roles.map((role) => {
            const deleteDisabled = role.is_system || role.user_count > 0;
            return (
              <Paper
                key={role.id}
                withBorder
                p={{ base: 'sm', sm: 'md' }}
                radius="md"
                bg="var(--bg-surface)"
              >
                <Stack gap="xs">
                  <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
                    <div style={{ minWidth: 0 }}>
                      <Group gap={6} mb={2} wrap="wrap">
                        <span
                          className="status-dot"
                          style={{
                            backgroundColor: role.is_system
                              ? 'var(--accent-primary)'
                              : 'var(--chart-pos)',
                          }}
                        />
                        <Text size="xs" fw={600} c="var(--text-body)">
                          {role.is_system ? 'System Role' : 'Custom Role'}
                        </Text>
                        <Text size="xs" c="var(--text-muted)">
                          · {role.user_count} user{role.user_count === 1 ? '' : 's'}
                        </Text>
                      </Group>
                      <Title order={5}>{role.name}</Title>
                    </div>

                    <Group gap={4} wrap="nowrap">
                      <ActionIcon
                        type="button"
                        variant="subtle"
                        color="gray"
                        aria-label={`Edit ${role.name}`}
                        onClick={() => openEditModal(role)}
                      >
                        <IconEdit size={15} />
                      </ActionIcon>
                      <ActionIcon
                        type="button"
                        variant="subtle"
                        color="gray"
                        disabled={deleteDisabled}
                        aria-label={`Delete ${role.name}`}
                        title={
                          role.is_system
                            ? 'System roles cannot be deleted'
                            : role.user_count > 0
                              ? 'Reassign users before deleting'
                              : 'Delete role'
                        }
                        onClick={() => handleDelete(role)}
                      >
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Group>
                  </Group>

                  {role.description && (
                    <Text size="xs" c="var(--text-muted)">
                      {role.description}
                    </Text>
                  )}

                  <Divider color="var(--border-divider)" />

                  <div>
                    <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                      Permissions ({role.permissions.length})
                    </Text>
                    <Text size="xs" c="var(--text-body)" lh={1.5}>
                      {role.permissions.map((k) => PERM_LABEL_BY_KEY[k] || k).join(' · ')}
                    </Text>
                  </div>
                </Stack>
              </Paper>
            );
          })}
        </SimpleGrid>
      )}

      <Modal
        opened={opened}
        onClose={close}
        title={editingRole ? `Edit Role: ${editingRole.name}` : 'Create Role'}
        size="md"
        fullScreen={isMobile}
      >
        <Box component="form" onSubmit={handleSubmit}>
          <Stack gap="sm">
            {formError && (
              <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />} title="Validation Error">
                {formError}
              </Alert>
            )}

            <TextInput
              label="Role Name"
              placeholder="Portfolio Lead"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              required
            />

            <Textarea
              label="Description"
              minRows={2}
              autosize
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />

            <Checkbox.Group
              label="Permissions"
              value={permissions}
              onChange={(vals) => setPermissions(vals as PermissionKey[])}
            >
              <Stack gap="sm" mt={6}>
                <div>
                  <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                    Workspace Access
                  </Text>
                  <Stack gap={6}>
                    {WORKSPACE_PERMISSIONS.map((p) => (
                      <Checkbox key={p.key} value={p.key} label={`${p.label} (${p.key})`} size="sm" />
                    ))}
                  </Stack>
                </div>

                <Divider color="var(--border-divider)" />

                <div>
                  <Text size="xs" fw={600} c="var(--text-muted)" mb={4}>
                    Administration
                  </Text>
                  <Stack gap={6}>
                    {ADMIN_PERMISSIONS.map((p) => (
                      <Checkbox key={p.key} value={p.key} label={`${p.label} (${p.key})`} size="sm" />
                    ))}
                  </Stack>
                </div>
              </Stack>
            </Checkbox.Group>

            <Group justify="flex-end" mt="xs" grow={isMobile}>
              <Button type="button" variant="default" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                {editingRole ? 'Save Changes' : 'Create Role'}
              </Button>
            </Group>
          </Stack>
        </Box>
      </Modal>
    </Stack>
  );
}

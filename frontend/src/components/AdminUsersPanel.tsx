import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertCircle, IconEdit, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import { api } from '../api/client';
import type { RoleOut, UserAuthProvider, UserOut, UserStatus } from '../types/api';

const STATUS_LABELS: Record<UserStatus, string> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
};

const STATUS_DOT_COLOR: Record<UserStatus, string> = {
  active: 'var(--chart-pos)',
  invited: 'var(--chart-warn)',
  disabled: 'var(--chart-neg)',
};

const PROVIDER_LABELS: Record<UserAuthProvider, string> = {
  firebase: 'Firebase',
  entra: 'Microsoft Entra ID',
  local: 'Local',
};

export function AdminUsersPanel() {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [users, setUsers] = useState<UserOut[]>([]);
  const [roles, setRoles] = useState<RoleOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchText, setSearchText] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const [opened, { open, close }] = useDisclosure(false);
  const [editingUser, setEditingUser] = useState<UserOut | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<string>('');
  const [status, setStatus] = useState<UserStatus>('active');
  const [authProvider, setAuthProvider] = useState<UserAuthProvider>('firebase');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [uList, rList] = await Promise.all([api.listUsers(), api.listRoles()]);
      setUsers(uList);
      setRoles(rList);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load users and roles.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const roleOptions = useMemo(
    () => roles.map((r) => ({ value: r.id, label: r.name })),
    [roles]
  );

  const filteredUsers = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role_id !== roleFilter) return false;
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (!q) return true;
      return (
        u.display_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role_name.toLowerCase().includes(q)
      );
    });
  }, [users, searchText, roleFilter, statusFilter]);

  const openCreateModal = () => {
    setEditingUser(null);
    setDisplayName('');
    setEmail('');
    setRoleId(roles.find((r) => r.id === 'role-analyst')?.id || roles[0]?.id || '');
    setStatus('active');
    setAuthProvider('firebase');
    setFormError(null);
    open();
  };

  const openEditModal = (u: UserOut) => {
    setEditingUser(u);
    setDisplayName(u.display_name);
    setEmail(u.email);
    setRoleId(u.role_id);
    setStatus(u.status);
    setAuthProvider(u.auth_provider);
    setFormError(null);
    open();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!displayName.trim()) {
      setFormError('Display name is required.');
      return;
    }
    if (!email.trim() || !email.includes('@')) {
      setFormError('A valid email address is required.');
      return;
    }
    if (!roleId) {
      setFormError('Please select a role.');
      return;
    }

    setSaving(true);
    try {
      if (editingUser) {
        await api.updateUser(editingUser.id, {
          display_name: displayName.trim(),
          email: email.trim().toLowerCase(),
          role_id: roleId,
          status,
          auth_provider: authProvider,
        });
        notifications.show({
          color: 'teal',
          title: 'User updated',
          message: `${displayName.trim()} (${email.trim().toLowerCase()})`,
        });
      } else {
        await api.createUser({
          display_name: displayName.trim(),
          email: email.trim().toLowerCase(),
          role_id: roleId,
          status,
          auth_provider: authProvider,
        });
        notifications.show({
          color: 'teal',
          title: 'User added',
          message: `${displayName.trim()} (${email.trim().toLowerCase()})`,
        });
      }
      close();
      await loadData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save user.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (u: UserOut) => {
    try {
      await api.deleteUser(u.id);
      await loadData();
      notifications.show({
        color: 'gray',
        title: 'User removed',
        message: `${u.display_name} (${u.email})`,
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot remove user',
        message: err instanceof Error ? err.message : 'Delete failed',
      });
    }
  };

  return (
    <Stack gap="md">
      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        <Group justify="space-between" align="center" wrap="wrap" gap="xs">
          <div>
            <Title order={4}>Users Management ({filteredUsers.length})</Title>
            <Text size="xs" c="var(--text-muted)">
              Provision user directory access, assign RBAC roles, and link Firebase or Entra identities
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
            Add User
          </Button>
        </Group>

        <search>
          <Group mt="md" gap="sm" wrap="wrap">
            <TextInput
              aria-label="Filter users"
              placeholder="Search name, email, or role..."
              leftSection={<IconSearch size={14} />}
              value={searchText}
              onChange={(e) => setSearchText(e.currentTarget.value)}
              style={{ flex: '1 1 200px', minWidth: 0, width: isMobile ? '100%' : undefined }}
            />
            <Select
              aria-label="Filter users by role"
              data={[{ value: 'all', label: 'All roles' }, ...roleOptions]}
              value={roleFilter}
              onChange={(v) => setRoleFilter(v || 'all')}
              allowDeselect={false}
              w={{ base: '100%', sm: 180 }}
            />
            <Select
              aria-label="Filter users by status"
              data={[
                { value: 'all', label: 'All statuses' },
                { value: 'active', label: 'Active' },
                { value: 'invited', label: 'Invited' },
                { value: 'disabled', label: 'Disabled' },
              ]}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v || 'all')}
              allowDeselect={false}
              w={{ base: '100%', sm: 160 }}
            />
          </Group>
        </search>
      </Paper>

      {loadError && (
        <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
          {loadError}
        </Alert>
      )}

      <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
        {loading && users.length === 0 ? (
          <Text size="sm" c="var(--text-muted)" py="md" ta="center">
            Loading users...
          </Text>
        ) : filteredUsers.length === 0 ? (
          <Text size="sm" c="var(--text-muted)" py="lg" ta="center">
            No matching users found.
          </Text>
        ) : isMobile ? (
          <Stack gap={0}>
            {filteredUsers.map((u, idx) => (
              <Fragment key={u.id}>
                {idx > 0 && <Divider color="var(--border-divider)" my="sm" />}
                <Stack gap={4}>
                  <Group justify="space-between" wrap="wrap" gap="xs">
                    <Group gap={6}>
                      <span
                        className="status-dot"
                        style={{ backgroundColor: STATUS_DOT_COLOR[u.status] }}
                      />
                      <Text size="xs" fw={600} c="var(--text-body)">
                        {STATUS_LABELS[u.status]}
                      </Text>
                      <Text size="xs" c="var(--text-muted)">
                        · {PROVIDER_LABELS[u.auth_provider]}
                      </Text>
                    </Group>
                    <Text size="xs" fw={600} c="var(--text-heading)">
                      {u.role_name}
                    </Text>
                  </Group>
                  <Text size="sm" fw={600} c="var(--text-heading)">
                    {u.display_name}
                  </Text>
                  <Text size="xs" c="var(--text-muted)">
                    {u.email}
                  </Text>
                  <Group justify="flex-end" gap="xs" mt={4}>
                    <Button
                      type="button"
                      size="xs"
                      variant="subtle"
                      color="gray"
                      leftSection={<IconEdit size={13} />}
                      onClick={() => openEditModal(u)}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="subtle"
                      color="gray"
                      leftSection={<IconTrash size={13} />}
                      onClick={() => handleDelete(u)}
                    >
                      Remove
                    </Button>
                  </Group>
                </Stack>
              </Fragment>
            ))}
          </Stack>
        ) : (
          <div tabIndex={0} role="region" aria-label="Users directory" className="table-region">
            <Table verticalSpacing="xs" horizontalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Role</Table.Th>
                  <Table.Th>Identity Provider</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Last Login</Table.Th>
                  <Table.Th ta="right">Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filteredUsers.map((u) => (
                  <Table.Tr key={u.id}>
                    <Table.Td className="cell-wrap">
                      <Text size="sm" fw={600} c="var(--text-heading)">
                        {u.display_name}
                      </Text>
                      <Text size="xs" c="var(--text-muted)">
                        {u.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>{u.role_name}</Table.Td>
                    <Table.Td>{PROVIDER_LABELS[u.auth_provider]}</Table.Td>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <span
                          className="status-dot"
                          style={{ backgroundColor: STATUS_DOT_COLOR[u.status] }}
                        />
                        <Text size="xs" fw={600} c="var(--text-body)">
                          {STATUS_LABELS[u.status]}
                        </Text>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <ActionIcon
                          type="button"
                          variant="subtle"
                          color="gray"
                          aria-label={`Edit ${u.display_name}`}
                          onClick={() => openEditModal(u)}
                        >
                          <IconEdit size={15} />
                        </ActionIcon>
                        <ActionIcon
                          type="button"
                          variant="subtle"
                          color="gray"
                          aria-label={`Delete ${u.display_name}`}
                          onClick={() => handleDelete(u)}
                        >
                          <IconTrash size={15} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Paper>

      <Modal
        opened={opened}
        onClose={close}
        title={editingUser ? `Edit User: ${editingUser.display_name}` : 'Add User'}
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
              label="Display Name"
              placeholder="Jane Doe"
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              required
            />

            <TextInput
              label="Email Address"
              placeholder="jane.doe@company.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
            />

            <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs">
              <Select
                label="Role"
                data={roleOptions}
                value={roleId}
                onChange={(v) => v && setRoleId(v)}
                allowDeselect={false}
                required
              />
              <Select
                label="Status"
                data={[
                  { value: 'active', label: 'Active' },
                  { value: 'invited', label: 'Invited' },
                  { value: 'disabled', label: 'Disabled' },
                ]}
                value={status}
                onChange={(v) => setStatus((v as UserStatus) || 'active')}
                allowDeselect={false}
              />
              <Select
                label="Auth Provider"
                data={[
                  { value: 'firebase', label: 'Firebase' },
                  { value: 'entra', label: 'Microsoft Entra ID' },
                  { value: 'local', label: 'Local' },
                ]}
                value={authProvider}
                onChange={(v) => setAuthProvider((v as UserAuthProvider) || 'firebase')}
                allowDeselect={false}
              />
            </SimpleGrid>

            <Group justify="flex-end" mt="xs" grow={isMobile}>
              <Button type="button" variant="default" onClick={close}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                {editingUser ? 'Save Changes' : 'Create User'}
              </Button>
            </Group>
          </Stack>
        </Box>
      </Modal>
    </Stack>
  );
}

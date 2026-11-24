import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Textarea,
  Timeline,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowBackUp,
  IconCheck,
  IconCircleDashed,
  IconLock,
  IconPlayerPlay,
  IconSend,
  IconX,
} from '@tabler/icons-react';
import { api } from '../api/client';
import type {
  ApprovalActionOut,
  ApprovalStepProgress,
  InitiativeApprovalOut,
  InitiativeStatus,
  WorkflowSummaryOut,
} from '../types/api';
import { ApprovalStatusBadge } from './ApprovalStatusBadge';
import { FieldLabel } from './FieldInfo';

type DialogKind = 'submit' | 'approve' | 'reject' | 'withdraw' | 'reopen';

const DIALOG_COPY: Record<DialogKind, { title: string; confirm: string; color: string; placeholder: string }> = {
  submit: {
    title: 'Submit for approval',
    confirm: 'Submit',
    color: 'blue',
    placeholder: 'Optional note for approvers',
  },
  approve: { title: 'Approve step', confirm: 'Approve', color: 'teal', placeholder: 'Optional comment' },
  reject: {
    title: 'Reject initiative',
    confirm: 'Reject',
    color: 'red',
    placeholder: 'Explain what needs to change (required)',
  },
  withdraw: {
    title: 'Withdraw approval request',
    confirm: 'Withdraw',
    color: 'gray',
    placeholder: 'Optional reason',
  },
  reopen: {
    title: 'Reopen as draft',
    confirm: 'Reopen',
    color: 'gray',
    placeholder: 'Optional reason (e.g. scope change)',
  },
};

const ACTION_LABEL: Record<ApprovalActionOut['action'], string> = {
  submit: 'Submitted',
  approve: 'Approved',
  reject: 'Rejected',
  withdraw: 'Withdrew request',
  reopen: 'Reopened as draft',
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function stepBullet(step: ApprovalStepProgress) {
  if (step.state === 'approved') return <IconCheck size={12} />;
  if (step.state === 'rejected') return <IconX size={12} />;
  if (step.state === 'active') return <IconPlayerPlay size={10} />;
  return <IconCircleDashed size={12} />;
}

interface Props {
  initiativeId: string;
  /** Called after any status change so the parent can refresh lists and locked state. */
  onStatusChange: (status: InitiativeStatus) => void;
}

export function InitiativeApprovalPanel({ initiativeId, onStatusChange }: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [approval, setApproval] = useState<InitiativeApprovalOut | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowSummaryOut[]>([]);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [comment, setComment] = useState('');
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setApproval(await api.getInitiativeApproval(initiativeId));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load approval status.');
    }
  }, [initiativeId]);

  useEffect(() => {
    setApproval(null);
    setShowHistory(false);
    load();
  }, [load]);

  const openDialog = async (kind: DialogKind) => {
    setComment('');
    setDialog(kind);
    if (kind === 'submit') {
      try {
        const active = await api.listActiveWorkflows();
        setWorkflows(active);
        setWorkflowId((active.find((w) => w.is_default) ?? active[0])?.id ?? null);
      } catch {
        setWorkflows([]);
      }
    }
  };

  const runAction = async () => {
    if (!dialog) return;
    setBusy(true);
    try {
      let next: InitiativeApprovalOut;
      if (dialog === 'submit') {
        next = await api.submitForApproval(initiativeId, { workflow_id: workflowId, comment });
      } else if (dialog === 'approve' || dialog === 'reject') {
        next = await api.decideApproval(initiativeId, { decision: dialog, comment });
      } else if (dialog === 'withdraw') {
        next = await api.withdrawApproval(initiativeId, comment);
      } else {
        next = await api.reopenInitiative(initiativeId, comment);
      }
      setApproval(next);
      setDialog(null);
      onStatusChange(next.status);
      notifications.show({
        color: 'teal',
        title: DIALOG_COPY[dialog].title,
        message:
          dialog === 'approve' && next.status === 'in_review'
            ? 'Approval recorded. The request moves on once the step has enough approvals.'
            : `Initiative is now ${next.status.replace('_', ' ')}.`,
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Action failed',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
      load();
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <Alert color="red" variant="light" title="Approval status unavailable">
        {loadError}
      </Alert>
    );
  }
  if (!approval) return null;

  const req = approval.current_request;
  const pending = req?.status === 'pending';
  const activeStep = pending && req.current_step_index != null ? req.steps[req.current_step_index] : null;
  const locked = approval.status === 'in_review' || approval.status === 'approved';
  const copy = dialog ? DIALOG_COPY[dialog] : null;
  const rejectNeedsComment = dialog === 'reject' && !comment.trim();
  const submitNeedsWorkflow = dialog === 'submit' && workflows.length > 1 && !workflowId;

  return (
    <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap="xs" wrap="nowrap">
              <Title order={5}>Approval</Title>
              <ApprovalStatusBadge status={approval.status} />
              {locked && (
                <Badge size="sm" variant="outline" color="gray" leftSection={<IconLock size={10} />}>
                  Locked
                </Badge>
              )}
            </Group>
            <Text size="xs" c="var(--text-muted)">
              {pending && activeStep
                ? `${req.workflow_name} · Step ${activeStep.index + 1} of ${req.steps.length}: ${activeStep.name}` +
                  (activeStep.required_approvals > 1
                    ? ` (${activeStep.approvals}/${activeStep.required_approvals} approvals)`
                    : '')
                : approval.status === 'approved' && req
                  ? `Approved via ${req.workflow_name}${req.completed_at ? ` on ${formatWhen(req.completed_at)}` : ''}`
                  : approval.status === 'rejected' && req
                    ? 'Rejected. Revise and resubmit, or reopen as a draft.'
                    : 'Not yet submitted. Submitting locks the initiative while it is reviewed.'}
            </Text>
          </Stack>

          <Group gap="xs" wrap="wrap">
            {approval.can_decide && (
              <>
                <Button
                  size="xs"
                  color="teal"
                  leftSection={<IconCheck size={13} />}
                  onClick={() => openDialog('approve')}
                >
                  Approve
                </Button>
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  leftSection={<IconX size={13} />}
                  onClick={() => openDialog('reject')}
                >
                  Reject
                </Button>
              </>
            )}
            {approval.can_submit && (
              <Button size="xs" leftSection={<IconSend size={13} />} onClick={() => openDialog('submit')}>
                {approval.status === 'rejected' ? 'Resubmit' : 'Submit for Approval'}
              </Button>
            )}
            {approval.can_withdraw && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconArrowBackUp size={13} />}
                onClick={() => openDialog('withdraw')}
              >
                Withdraw
              </Button>
            )}
            {approval.can_reopen && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconArrowBackUp size={13} />}
                onClick={() => openDialog('reopen')}
              >
                Reopen as Draft
              </Button>
            )}
          </Group>
        </Group>

        {pending && !approval.can_decide && approval.decide_blocked_reason && (
          <Text size="xs" c="var(--text-muted)">
            {approval.decide_blocked_reason}
          </Text>
        )}

        {req && (pending || showHistory) && (
          <Timeline
            active={req.steps.findIndex((s) => s.state === 'active' || s.state === 'rejected')}
            bulletSize={20}
            lineWidth={2}
          >
            {req.steps.map((step) => (
              <Timeline.Item
                key={step.index}
                bullet={stepBullet(step)}
                color={step.state === 'rejected' ? 'red' : step.state === 'approved' ? 'teal' : 'blue'}
                title={
                  <Group gap={6}>
                    <Text size="sm" fw={600} c="var(--text-heading)">
                      {step.name}
                    </Text>
                    <Text size="xs" c="var(--text-muted)">
                      {step.approvals}/{step.required_approvals}
                    </Text>
                  </Group>
                }
              >
                <Text size="xs" c="var(--text-muted)">
                  {step.approvers.join(', ') || 'No approvers configured'}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        )}

        {approval.history.length > 0 && (
          <Button
            variant="subtle"
            size="compact-xs"
            color="gray"
            w="fit-content"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? 'Hide history' : `Show history (${approval.history.length})`}
          </Button>
        )}

        {showHistory && (
          <Stack gap={6}>
            {approval.history.map((a) => (
              <div key={a.id} style={{ borderLeft: '2px solid var(--border-subtle)', paddingLeft: 10 }}>
                <Text size="xs" c="var(--text-heading)">
                  <b>{a.actor_name || 'Workspace user'}</b> {ACTION_LABEL[a.action].toLowerCase()}
                  {a.step_name ? ` · ${a.step_name}` : ''}
                </Text>
                <Text size="xs" c="var(--text-muted)">
                  {formatWhen(a.created_at)}
                </Text>
                {a.comment && (
                  <Text size="xs" c="var(--text-body)" style={{ whiteSpace: 'pre-wrap' }}>
                    “{a.comment}”
                  </Text>
                )}
              </div>
            ))}
          </Stack>
        )}
      </Stack>

      <Modal
        opened={dialog !== null}
        onClose={() => !busy && setDialog(null)}
        title={copy?.title}
        centered
        fullScreen={isMobile}
      >
        <Stack gap="sm">
          {dialog === 'submit' &&
            (workflows.length === 0 ? (
              <Alert color="yellow" variant="light">
                No active approval workflow is defined. Ask an administrator to create one.
              </Alert>
            ) : (
              <Select
                label={<FieldLabel field="approval.workflow">Approval workflow</FieldLabel>}
                data={workflows.map((w) => ({
                  value: w.id,
                  label: w.is_default ? `${w.name} (default)` : w.name,
                }))}
                value={workflowId}
                onChange={setWorkflowId}
                allowDeselect={false}
                description={
                  workflows.find((w) => w.id === workflowId)?.step_names.join(' → ') || undefined
                }
              />
            ))}
          {dialog === 'submit' && (
            <Text size="xs" c="var(--text-muted)">
              The initiative, its BCAs, and line items are locked while under review.
            </Text>
          )}
          <Textarea
            label={<FieldLabel field="approval.comment">Comment</FieldLabel>}
            placeholder={copy?.placeholder}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={3}
            maxLength={2000}
            required={dialog === 'reject'}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setDialog(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              color={copy?.color}
              loading={busy}
              onClick={runAction}
              disabled={
                rejectNeedsComment || submitNeedsWorkflow || (dialog === 'submit' && workflows.length === 0)
              }
            >
              {copy?.confirm}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}

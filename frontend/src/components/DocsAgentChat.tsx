import { Fragment, useEffect, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  CopyButton,
  Group,
  Paper,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconCheck,
  IconCopy,
  IconPlayerStop,
  IconRefresh,
  IconSend,
  IconSettings,
  IconSparkles,
} from '@tabler/icons-react';
import { api, ApiError } from '../api/client';
import type { DocCitation, InitiativeDetail, LLMSettingsOut } from '../types/api';

interface Props {
  llmSettings: LLMSettingsOut | null;
  activeDocSlug?: string | null;
  activeInitiative?: InitiativeDetail | null;
  onNavigateDoc: (slug: string) => void;
  onOpenAdmin: () => void;
  compact?: boolean;
}

interface UiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: DocCitation[];
  error?: boolean;
}

const STARTER_PROMPTS = [
  'When should I use BEN-TOIL-01 vs BEN-FLOW-01?',
  'Walk through a worked PV calculation for COST-BUILD-01.',
  'How do S-curve ramps and discounted payback work?',
  'How do anti-double-counting tags and guardrails work?',
];

function renderInlineFormatting(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

function renderMarkdownBlocks(markdown: string): React.ReactNode[] {
  const segments = markdown.split(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g);
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < segments.length; i += 3) {
    const prose = segments[i] ?? '';
    const lang = segments[i + 1];
    const code = segments[i + 2];

    if (prose.trim()) {
      const blocks = prose.trim().split(/\n{2,}/);
      blocks.forEach((block, bIdx) => {
        const trimmed = block.trim();
        if (!trimmed) return;
        const lines = trimmed.split('\n');
        const key = `p-${i}-${bIdx}`;

        if (lines.every((l) => /^[-*]\s+/.test(l.trim()))) {
          nodes.push(
            <ul key={key}>
              {lines.map((l, li) => (
                <li key={li}>{renderInlineFormatting(l.trim().replace(/^[-*]\s+/, ''), `${key}-${li}`)}</li>
              ))}
            </ul>
          );
          return;
        }

        if (lines.every((l) => /^\d+\.\s+/.test(l.trim()))) {
          nodes.push(
            <ol key={key}>
              {lines.map((l, li) => (
                <li key={li}>{renderInlineFormatting(l.trim().replace(/^\d+\.\s+/, ''), `${key}-${li}`)}</li>
              ))}
            </ol>
          );
          return;
        }

        const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
        if (headingMatch && lines.length === 1) {
          nodes.push(
            <Text key={key} fw={700} size="sm" c="var(--text-heading)" mb={4}>
              {renderInlineFormatting(headingMatch[2], key)}
            </Text>
          );
          return;
        }

        nodes.push(
          <p key={key}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {renderInlineFormatting(l, `${key}-${li}`)}
              </Fragment>
            ))}
          </p>
        );
      });
    }

    if (code !== undefined) {
      nodes.push(
        <pre key={`code-${i}`} aria-label={lang ? `${lang} code block` : 'Code block'}>
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      );
    }
  }

  return nodes;
}

export function DocsAgentChat({
  llmSettings,
  activeDocSlug,
  activeInitiative,
  onNavigateDoc,
  onOpenAdmin,
  compact = false,
}: Props) {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const [messages, setMessages] = useState<UiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [focusCurrentDoc, setFocusCurrentDoc] = useState(true);
  const [includeInitiative, setIncludeInitiative] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const effectiveDocSlug =
    activeDocSlug && activeDocSlug !== 'ask' && focusCurrentDoc ? activeDocSlug : null;

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const configured = Boolean(llmSettings?.configured);

  const sendPrompt = async (promptText: string) => {
    const cleaned = promptText.trim();
    if (!cleaned || streaming) return;

    setErrorMsg(null);
    const userMsg: UiChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: cleaned,
    };
    const assistantId = `a-${Date.now()}`;
    const placeholderAssistant: UiChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      citations: [],
    };

    const historyForApi = [...messages, userMsg]
      .filter((m) => !m.error && m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg, placeholderAssistant]);
    setInput('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await api.streamDocsChat(
        {
          model: 'bca-docs-agent',
          messages: historyForApi,
          stream: true,
          doc_slug: effectiveDocSlug,
          initiative_id: includeInitiative && activeInitiative ? activeInitiative.id : null,
          include_initiative_context: Boolean(includeInitiative && activeInitiative),
        },
        {
          signal: controller.signal,
          onCitations: (citations) => {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, citations } : m))
            );
          },
          onDelta: (chunk) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + chunk } : m
              )
            );
          },
        }
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId && !m.content
              ? { ...m, content: '_Generation stopped._' }
              : m
          )
        );
      } else {
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to reach Docs Agent endpoint.';
        setErrorMsg(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: m.content || `Error: ${msg}`, error: true }
              : m
          )
        );
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  return (
    <div
      className="chat-shell"
      style={{ height: compact ? 'calc(100dvh - 110px)' : undefined }}
    >
      {/* Provider status & context toggles */}
      <Paper withBorder p="xs" radius="md" bg="var(--bg-surface)">
        <Stack gap="xs">
          <Group justify="space-between" wrap="wrap" gap="xs">
            <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
              <span
                className="status-dot"
                style={{
                  backgroundColor: configured ? 'var(--chart-pos)' : 'var(--chart-warn)',
                }}
              />
              <Text size="xs" fw={600} c="var(--text-heading)">
                Docs Agent
              </Text>
              <Text size="xs" c="var(--text-muted)" ff="monospace">
                · {configured ? llmSettings?.model : 'Not configured'}
              </Text>
            </Group>

            <Group gap="xs" wrap="nowrap">
              {messages.length > 0 && (
                <Button
                  type="button"
                  size="compact-xs"
                  variant="subtle"
                  leftSection={<IconRefresh size={13} />}
                  onClick={() => {
                    abortRef.current?.abort();
                    setMessages([]);
                    setErrorMsg(null);
                  }}
                >
                  New chat
                </Button>
              )}
              <Button
                type="button"
                size="compact-xs"
                variant="default"
                leftSection={<IconSettings size={13} />}
                onClick={onOpenAdmin}
              >
                Admin
              </Button>
            </Group>
          </Group>

          {(activeDocSlug && activeDocSlug !== 'ask') || activeInitiative ? (
            <Group gap="md" wrap="wrap">
              {activeDocSlug && activeDocSlug !== 'ask' && (
                <Switch
                  size="xs"
                  checked={focusCurrentDoc}
                  onChange={(e) => setFocusCurrentDoc(e.currentTarget.checked)}
                  label={`Focus: ${activeDocSlug}`}
                />
              )}
              {activeInitiative && (
                <Switch
                  size="xs"
                  checked={includeInitiative}
                  onChange={(e) => setIncludeInitiative(e.currentTarget.checked)}
                  label={`Include initiative: ${activeInitiative.name}`}
                />
              )}
            </Group>
          ) : null}
        </Stack>
      </Paper>

      {!configured && (
        <div className="callout-note" role="note">
          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <Text size="xs" c="inherit">
              Configure an OpenAI-compatible Endpoint URL, API key (if required), and model in Admin to enable answers.
            </Text>
            <Button type="button" size="compact-xs" variant="default" onClick={onOpenAdmin}>
              Configure Provider
            </Button>
          </Group>
        </div>
      )}

      {errorMsg && (
        <Alert color="red" variant="light" p="xs">
          <Text size="xs">{errorMsg}</Text>
        </Alert>
      )}

      {/* Messages area */}
      <div
        className="chat-messages"
        style={{
          flex: compact ? '1 1 0' : undefined,
          minHeight: compact ? 180 : 280,
          maxHeight: compact ? undefined : '58dvh',
        }}
      >
        {messages.length === 0 ? (
          <Paper withBorder p={{ base: 'sm', sm: 'md' }} radius="md" bg="var(--bg-surface)">
            <Stack gap="sm">
              <Group gap={6}>
                <IconSparkles size={16} color="var(--accent-primary)" />
                <Title order={5}>Ask about catalog models, formulas, ramps, or guardrails</Title>
              </Group>
              <Text size="xs" c="var(--text-muted)">
                Grounded in all methodology guides, all 9 built-in catalog items, custom expr formulas, and optionally your active initiative.
              </Text>
              <Stack gap="xs">
                {STARTER_PROMPTS.map((prompt) => (
                  <Button
                    key={prompt}
                    type="button"
                    variant="default"
                    size="xs"
                    disabled={streaming}
                    onClick={() => sendPrompt(prompt)}
                    styles={{
                      root: {
                        height: 'auto',
                        paddingBlock: 8,
                        justifyContent: 'flex-start',
                      },
                      label: {
                        whiteSpace: 'normal',
                        textAlign: 'left',
                        fontWeight: 500,
                      },
                    }}
                  >
                    {prompt}
                  </Button>
                ))}
              </Stack>
            </Stack>
          </Paper>
        ) : (
          messages.map((msg) =>
            msg.role === 'user' ? (
              <div key={msg.id} className="chat-msg-user">
                <Text size="xs" fw={600} c="var(--text-muted)" mb={2}>
                  You
                </Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content}
                </Text>
              </div>
            ) : (
              <div key={msg.id} className="chat-msg-assistant">
                <Group justify="space-between" align="center" mb={6} wrap="nowrap">
                  <Group gap={6}>
                    <span
                      className="status-dot"
                      style={{
                        backgroundColor: msg.error ? 'var(--chart-neg)' : 'var(--accent-primary)',
                      }}
                    />
                    <Text size="xs" fw={600} c="var(--text-heading)">
                      Docs Agent
                    </Text>
                  </Group>
                  {msg.content && (
                    <CopyButton value={msg.content}>
                      {({ copied, copy }) => (
                        <ActionIcon
                          type="button"
                          size="xs"
                          variant="subtle"
                          color="gray"
                          aria-label={copied ? 'Copied response' : 'Copy response'}
                          onClick={copy}
                        >
                          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                        </ActionIcon>
                      )}
                    </CopyButton>
                  )}
                </Group>

                <div className="chat-markdown">
                  {msg.content ? (
                    renderMarkdownBlocks(msg.content)
                  ) : (
                    <Text size="xs" c="var(--text-muted)">
                      Thinking...
                    </Text>
                  )}
                </div>

                {msg.citations && msg.citations.length > 0 && (
                  <Group gap="xs" mt="xs" pt="xs" wrap="wrap" style={{ borderTop: '1px solid var(--border-divider)' }}>
                    <Text size="xs" c="var(--text-muted)">
                      Sources:
                    </Text>
                    {msg.citations.map((cit) => (
                      <Button
                        key={cit.slug}
                        type="button"
                        size="compact-xs"
                        variant="subtle"
                        px={6}
                        onClick={() => onNavigateDoc(cit.slug)}
                        leftSection={
                          <span
                            className="status-dot"
                            style={{
                              backgroundColor:
                                cit.kind === 'cost'
                                  ? 'var(--chart-neg)'
                                  : cit.kind === 'benefit'
                                    ? 'var(--chart-pos)'
                                    : 'var(--accent-primary)',
                            }}
                          />
                        }
                      >
                        {cit.slug}
                      </Button>
                    ))}
                  </Group>
                )}
              </div>
            )
          )
        )}
        <div ref={scrollEndRef} />
      </div>

      {/* Composer */}
      <Paper
        component="form"
        withBorder
        p="xs"
        radius="md"
        bg="var(--bg-surface)"
        onSubmit={(e) => {
          e.preventDefault();
          sendPrompt(input);
        }}
      >
        <Stack gap="xs">
          <Textarea
            aria-label="Ask the Docs Agent a question"
            placeholder="Ask a question about costs, benefits, formulas, Monte Carlo, or your model..."
            autosize
            minRows={isMobile ? 2 : 2}
            maxRows={5}
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendPrompt(input);
              }
            }}
          />
          <Group justify="space-between" align="center" wrap="wrap" gap="xs">
            <Text size="xs" c="var(--text-muted)">
              Enter to send · Shift+Enter newline
            </Text>
            <Group gap="xs">
              {streaming && (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  leftSection={<IconPlayerStop size={13} />}
                  onClick={handleStop}
                >
                  Stop
                </Button>
              )}
              <Button
                type="submit"
                size="xs"
                loading={streaming}
                disabled={!input.trim() || streaming}
                leftSection={<IconSend size={13} />}
              >
                Ask
              </Button>
            </Group>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
}

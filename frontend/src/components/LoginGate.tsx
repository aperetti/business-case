import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  Divider,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconBrandGoogle,
  IconBrandWindows,
  IconLock,
  IconLogout,
  IconMoon,
  IconSun,
} from '@tabler/icons-react';
import type { Auth } from 'firebase/auth';
import {
  formatFirebaseAuthError,
  requestPasswordReset,
  signInWithEmail,
  signInWithGoogle,
  signInWithMicrosoft,
} from '../auth/firebase';
import type { SSOPublicConfigOut } from '../types/api';

interface Props {
  ssoConfig: SSOPublicConfigOut;
  firebaseAuth: Auth | null;
  mode: 'unauthenticated' | 'unauthorized';
  signedInEmail?: string | null;
  errorMessage?: string | null;
  onSignOut: () => Promise<void>;
  onDismissOptional?: () => void;
}

export function LoginGate({
  ssoConfig,
  firebaseAuth,
  mode,
  signedInEmail,
  errorMessage,
  onSignOut,
  onDismissOptional,
}: Props) {
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme('dark');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const methods = ssoConfig.firebase_sign_in_methods || ['google'];
  const showGoogle = methods.includes('google');
  const showMicrosoft = methods.includes('microsoft');
  const showEmailPassword = methods.includes('email_password');
  const activeError = errorMessage || localError;

  const handleFederated = async (kind: 'google' | 'microsoft') => {
    if (!firebaseAuth) return;
    setLocalError(null);
    setResetNotice(null);
    setBusyProvider(kind);
    try {
      if (kind === 'google') {
        await signInWithGoogle(firebaseAuth);
      } else {
        await signInWithMicrosoft(firebaseAuth);
      }
    } catch (err) {
      setLocalError(formatFirebaseAuthError(err));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firebaseAuth || !email.trim() || !password) return;
    setLocalError(null);
    setResetNotice(null);
    setBusyProvider('email_password');
    try {
      await signInWithEmail(firebaseAuth, email, password);
    } catch (err) {
      setLocalError(formatFirebaseAuthError(err));
    } finally {
      setBusyProvider(null);
    }
  };

  const handleForgotPassword = async () => {
    if (!firebaseAuth) return;
    if (!email.trim()) {
      setLocalError('Enter your email address above first so we can send a reset link.');
      return;
    }
    setLocalError(null);
    setResetNotice(null);
    setBusyProvider('reset');
    try {
      await requestPasswordReset(firebaseAuth, email);
      setResetNotice(`Password reset email sent to ${email.trim()}.`);
    } catch (err) {
      setLocalError(formatFirebaseAuthError(err));
    } finally {
      setBusyProvider(null);
    }
  };

  return (
    <Center
      mih="100dvh"
      p="md"
      style={{ backgroundColor: 'var(--bg-canvas)', position: 'relative' }}
    >
      <ActionIcon
        type="button"
        variant="subtle"
        color="gray"
        size="md"
        aria-label="Toggle color scheme"
        onClick={() => setColorScheme(computedColorScheme === 'dark' ? 'light' : 'dark')}
        style={{ position: 'absolute', top: 16, right: 16 }}
      >
        {computedColorScheme === 'dark' ? (
          <IconSun size={18} color="var(--text-muted)" />
        ) : (
          <IconMoon size={18} color="var(--text-muted)" />
        )}
      </ActionIcon>

      <Paper
        withBorder
        radius="md"
        p="xl"
        bg="var(--bg-surface)"
        w="100%"
        maw={420}
        shadow="md"
      >
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <div>
              <Title order={3} c="var(--text-heading)">
                ValueStream BCA
              </Title>
              <Text size="xs" c="var(--text-muted)" mt={2}>
                Cross-Domain Value Stream & Monte Carlo Platform
              </Text>
            </div>
            <Badge variant="light" color="blue" leftSection={<IconLock size={11} />}>
              Firebase SSO
            </Badge>
          </Group>

          {mode === 'unauthorized' ? (
            <Stack gap="sm">
              <Alert
                color="red"
                variant="light"
                icon={<IconAlertCircle size={16} />}
                title="Access Restricted"
              >
                <Stack gap={4}>
                  {signedInEmail && (
                    <Text size="xs">
                      Signed in as <strong>{signedInEmail}</strong>.
                    </Text>
                  )}
                  <Text size="xs">
                    {activeError ||
                      'Your account is not authorized to access this ValueStream BCA workspace.'}
                  </Text>
                </Stack>
              </Alert>
              <Button
                type="button"
                variant="default"
                fullWidth
                leftSection={<IconLogout size={15} />}
                loading={busyProvider === 'signout'}
                onClick={async () => {
                  setBusyProvider('signout');
                  try {
                    await onSignOut();
                  } finally {
                    setBusyProvider(null);
                  }
                }}
              >
                Sign out & use a different account
              </Button>
            </Stack>
          ) : (
            <Stack gap="sm">
              <Text size="sm" c="var(--text-body)">
                Sign in to access initiatives, Monte Carlo certainty modeling, and workspace analytics.
              </Text>

              {activeError && (
                <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
                  <Text size="xs">{activeError}</Text>
                </Alert>
              )}

              {resetNotice && (
                <Alert color="teal" variant="light">
                  <Text size="xs">{resetNotice}</Text>
                </Alert>
              )}

              {showEmailPassword && (
                <form onSubmit={handleEmailSubmit}>
                  <Stack gap="xs">
                    <TextInput
                      id="email"
                      name="email"
                      type="email"
                      label="Email"
                      placeholder="you@company.com"
                      autoComplete="username"
                      spellCheck={false}
                      enterKeyHint="next"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.currentTarget.value)}
                    />
                    <PasswordInput
                      id="current-password"
                      name="password"
                      label="Password"
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      enterKeyHint="done"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.currentTarget.value)}
                    />
                    <Group justify="flex-end">
                      <Anchor
                        component="button"
                        type="button"
                        size="xs"
                        onClick={handleForgotPassword}
                      >
                        Forgot password?
                      </Anchor>
                    </Group>
                    <Button
                      type="submit"
                      fullWidth
                      loading={busyProvider === 'email_password'}
                      disabled={busyProvider !== null && busyProvider !== 'email_password'}
                    >
                      Sign In
                    </Button>
                  </Stack>
                </form>
              )}

              {showEmailPassword && (showGoogle || showMicrosoft) && (
                <Divider label="or" labelPosition="center" />
              )}

              {(showGoogle || showMicrosoft) && (
                <Stack gap="xs">
                  {showGoogle && (
                    <Button
                      type="button"
                      size="md"
                      variant={showEmailPassword ? 'default' : 'filled'}
                      fullWidth
                      leftSection={<IconBrandGoogle size={17} />}
                      loading={busyProvider === 'google'}
                      disabled={busyProvider !== null && busyProvider !== 'google'}
                      onClick={() => handleFederated('google')}
                    >
                      Sign in with Google
                    </Button>
                  )}
                  {showMicrosoft && (
                    <Button
                      type="button"
                      size="md"
                      variant="default"
                      fullWidth
                      leftSection={<IconBrandWindows size={17} />}
                      loading={busyProvider === 'microsoft'}
                      disabled={busyProvider !== null && busyProvider !== 'microsoft'}
                      onClick={() => handleFederated('microsoft')}
                    >
                      Sign in with Microsoft
                    </Button>
                  )}
                </Stack>
              )}

              {!showGoogle && !showMicrosoft && !showEmailPassword && (
                <Alert color="yellow" variant="light">
                  <Text size="xs">
                    No supported web sign-in methods are enabled in Firebase SSO configuration.
                  </Text>
                </Alert>
              )}

              {onDismissOptional && (
                <Button type="button" variant="subtle" size="xs" onClick={onDismissOptional}>
                  Cancel & return to workspace
                </Button>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
    </Center>
  );
}

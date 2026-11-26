import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  AppShell,
  Avatar,
  Badge,
  Burger,
  Button,
  Center,
  Drawer,
  Group,
  Loader,
  Menu,
  Paper,
  Stack,
  Tabs,
  Text,
  Title,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconBook,
  IconBooks,
  IconChartHistogram,
  IconLayoutDashboard,
  IconLogin,
  IconLogout,
  IconMessageCircle,
  IconMoon,
  IconScale,
  IconSettings,
  IconSun,
} from '@tabler/icons-react';
import { onAuthStateChanged, type Auth } from 'firebase/auth';
import { api, ApiError, setAuthTokenProvider } from './api/client';
import {
  consumeFirebaseRedirect,
  formatFirebaseAuthError,
  getFirebaseAuthInstance,
  signOutFirebase,
} from './auth/firebase';
import { AdminPortal } from './components/AdminPortal';
import { AdminSidebar } from './components/AdminSidebar';
import { BCAComparisonDashboard } from './components/BCAComparisonDashboard';
import { BCASelectorBar, CreateBCAModal } from './components/BCASelectorBar';
import { CatalogManager } from './components/CatalogManager';
import { DeterministicOverview } from './components/DeterministicOverview';
import { DocsAgentChat } from './components/DocsAgentChat';
import { DocsSite } from './components/DocsSite';
import { KeepAlivePanel } from './components/KeepAlivePanel';
import { InitiativeSettingsBar } from './components/InitiativeSettingsBar';
import { InitiativeApprovalPanel } from './components/InitiativeApprovalPanel';
import { InitiativeSidebar } from './components/InitiativeSidebar';
import { LineItemDrawer } from './components/LineItemDrawer';
import { LineItemsTable } from './components/LineItemsTable';
import { LoginGate } from './components/LoginGate';
import { MonteCarloDashboard } from './components/MonteCarloDashboard';
import { NonMonetaryBenefitsPanel } from './components/NonMonetaryBenefitsPanel';
import { PairwisePlot } from './components/PairwisePlot';
import type {
  AdminSection,
  AuthUserOut,
  BCACompareRequest,
  BCAComparisonRecord,
  BCAComparisonResult,
  BCACreate,
  BCAUpdate,
  CatalogEntry,
  CatalogEntryCreate,
  CatalogEntryUpdate,
  InitiativeCreate,
  InitiativeDetail,
  InitiativeItemCreate,
  InitiativeItemOut,
  InitiativeSummary,
  InitiativeUpdate,
  LLMSettingsOut,
  SSOPublicConfigOut,
  SimulationRequest,
  SimulationResult,
  SimulationRunRecord,
} from './types/api';

const ADMIN_SECTIONS: AdminSection[] = ['users', 'roles', 'sso', 'workflows', 'ai', 'api-keys', 'odata'];

function parseRouteHash():
  | { mode: 'admin'; adminSection: AdminSection }
  | { mode: 'workspace'; tab: string; docSlug?: string }
  | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  if (h === '#admin' || h === '#admin/') {
    return { mode: 'admin', adminSection: 'users' };
  }
  const adminMatch = h.match(/^#admin\/([a-z-]+)$/);
  if (adminMatch) {
    const candidate = adminMatch[1] as AdminSection;
    return {
      mode: 'admin',
      adminSection: ADMIN_SECTIONS.includes(candidate) ? candidate : 'users',
    };
  }
  const match = h.match(/^#docs\/(.+)$/);
  if (!match) return null;
  try {
    return { mode: 'workspace', tab: 'docs', docSlug: decodeURIComponent(match[1]) };
  } catch {
    return { mode: 'workspace', tab: 'docs', docSlug: match[1] };
  }
}

/** `#initiative/<id>` deep links (used in approval emails). Returns the id once and clears the hash. */
function consumeInitiativeHash(): string | null {
  if (typeof window === 'undefined') return null;
  const m = window.location.hash.match(/^#initiative\/([A-Za-z0-9-]+)$/);
  if (!m) return null;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
}

export default function App() {
  const isMobile = useMediaQuery('(max-width: 48em)') ?? false;
  const { setColorScheme } = useMantineColorScheme();
  const computedColorScheme = useComputedColorScheme('dark');
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  const [chatDrawerOpen, { open: openChatDrawer, close: closeChatDrawer }] = useDisclosure(false);
  const initialRoute = parseRouteHash();
  const [adminMode, setAdminMode] = useState<boolean>(initialRoute?.mode === 'admin');
  const [adminSection, setAdminSection] = useState<AdminSection>(
    initialRoute?.mode === 'admin' ? initialRoute.adminSection : 'users'
  );
  const [activeTab, setActiveTab] = useState<string>(
    initialRoute?.mode === 'workspace' ? initialRoute.tab : 'assumptions'
  );
  const [activeDocSlug, setActiveDocSlug] = useState<string>(
    initialRoute?.mode === 'workspace' && initialRoute.docSlug ? initialRoute.docSlug : 'overview'
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingApprovalIds, setPendingApprovalIds] = useState<Set<string>>(new Set());
  const [llmSettings, setLlmSettings] = useState<LLMSettingsOut | null>(null);
  const [docsAgentAvailable, setDocsAgentAvailable] = useState(false);

  const [authPhase, setAuthPhase] = useState<
    'checking' | 'unauthenticated' | 'unauthorized' | 'ready'
  >('checking');
  const [ssoPublic, setSsoPublic] = useState<SSOPublicConfigOut | null>(null);
  const [firebaseAuth, setFirebaseAuth] = useState<Auth | null>(null);
  const [authUser, setAuthUser] = useState<AuthUserOut | null>(null);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showOptionalLoginModal, setShowOptionalLoginModal] = useState(false);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [initiatives, setInitiatives] = useState<InitiativeSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBcaId, setSelectedBcaId] = useState<string | null>(null);
  const [initiativeDetail, setInitiativeDetail] = useState<InitiativeDetail | null>(null);

  const [drawerOpen, { open: openDrawer, close: closeDrawer }] = useDisclosure(false);
  const [editingItem, setEditingItem] = useState<InitiativeItemOut | null>(null);
  const [draftItem, setDraftItem] = useState<Partial<InitiativeItemCreate> | null>(null);

  const [bcaModalOpen, { open: openBcaModal, close: closeBcaModal }] = useDisclosure(false);
  const [bcaCloneSourceId, setBcaCloneSourceId] = useState<string | null>(null);

  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [runs, setRuns] = useState<SimulationRunRecord[]>([]);
  const [simRunning, setSimRunning] = useState(false);

  const [comparisons, setComparisons] = useState<BCAComparisonRecord[]>([]);
  const [activeComparison, setActiveComparison] = useState<BCAComparisonResult | null>(null);
  const [compareRunning, setCompareRunning] = useState(false);

  const refreshInitiativeData = useCallback(async (initId: string, bcaId?: string | null) => {
    const [detail, history, compHistory] = await Promise.all([
      api.getInitiative(initId, bcaId),
      api.listRuns(initId),
      api.listComparisons(initId),
    ]);
    const resolvedBcaId = detail.active_bca_id ?? bcaId ?? detail.bcas[0]?.id ?? null;
    const baselineId = detail.bcas.find((b) => b.is_baseline)?.id ?? detail.bcas[0]?.id ?? null;
    setInitiativeDetail(detail);
    setSelectedBcaId(resolvedBcaId);
    setRuns(history);
    setComparisons(compHistory);
    setSimResult((prev) => {
      if (
        prev &&
        prev.initiative_id === initId &&
        (prev.bca_id ?? baselineId) === resolvedBcaId
      ) {
        return prev;
      }
      const match = history.find((r) => (r.bca_id ?? baselineId) === resolvedBcaId);
      return match?.summary ?? null;
    });
    setActiveComparison((prev) => {
      if (prev && prev.initiative_id === initId) return prev;
      return compHistory[0]?.summary ?? null;
    });
  }, []);

  const refreshPendingApprovals = useCallback(async () => {
    try {
      const pending = await api.listPendingApprovals();
      setPendingApprovalIds(new Set(pending.map((p) => p.initiative_id)));
    } catch {
      setPendingApprovalIds(new Set());
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [, cat, inits, llm, docsStatus] = await Promise.all([
        api.health(),
        api.listCatalog(),
        api.listInitiatives(),
        api.getLLMSettings().catch(() => null),
        api.getDocsAgentStatus().catch(() => null),
      ]);
      setCatalog(cat);
      setInitiatives(inits);
      if (llm) setLlmSettings(llm);
      setDocsAgentAvailable(
        Boolean(docsStatus?.available ?? (llm?.configured && llm?.verified))
      );
      if (inits.length > 0) {
        const linkedId = consumeInitiativeHash();
        const firstId = inits.some((i) => i.id === linkedId) ? (linkedId as string) : inits[0].id;
        setSelectedId(firstId);
        await refreshInitiativeData(firstId);
      }
      refreshPendingApprovals();
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : 'Unable to reach BCA backend API on /api.'
      );
    } finally {
      setLoading(false);
    }
  }, [refreshInitiativeData, refreshPendingApprovals]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribeAuth: (() => void) | null = null;

    const initAuth = async () => {
      try {
        const pub = await api.getSSOPublicConfig();
        if (cancelled) return;
        setSsoPublic(pub);

        const ssoActive = pub.enabled && pub.configured && pub.provider === 'firebase';
        if (!ssoActive) {
          setAuthTokenProvider(null);
          setAuthPhase('ready');
          return;
        }

        const fbAuth = getFirebaseAuthInstance(pub);
        if (cancelled) return;
        setFirebaseAuth(fbAuth);

        setAuthTokenProvider(async (forceRefresh = false) => {
          const current = fbAuth.currentUser;
          if (!current) return null;
          return current.getIdToken(forceRefresh);
        });

        try {
          await consumeFirebaseRedirect(fbAuth);
        } catch (err) {
          if (!cancelled) {
            setAuthError(formatFirebaseAuthError(err));
          }
        }

        unsubscribeAuth = onAuthStateChanged(fbAuth, async (fbUser) => {
          if (cancelled) return;
          setAuthError(null);
          if (!fbUser) {
            setAuthUser(null);
            setSignedInEmail(null);
            setAdminMode(false);
            setAuthPhase(pub.enforce_sso ? 'unauthenticated' : 'ready');
            return;
          }

          setSignedInEmail(fbUser.email);
          try {
            const me = await api.getAuthMe();
            if (cancelled) return;
            setAuthUser(me.user);
            setShowOptionalLoginModal(false);
            setAuthPhase('ready');
          } catch (err) {
            if (cancelled) return;
            setAuthUser(null);
            if (err instanceof ApiError && err.status === 403) {
              setAuthError(err.message);
              if (pub.enforce_sso) {
                setAuthPhase('unauthorized');
              } else {
                setAuthPhase('ready');
                notifications.show({
                  color: 'red',
                  title: 'Sign-in restricted',
                  message: err.message,
                });
              }
            } else if (err instanceof ApiError && err.status === 401) {
              setAuthError(err.message);
              setAuthPhase(pub.enforce_sso ? 'unauthenticated' : 'ready');
            } else {
              setAuthError(
                err instanceof Error ? err.message : 'Authentication check failed.'
              );
              setAuthPhase(pub.enforce_sso ? 'unauthorized' : 'ready');
            }
          }
        });
      } catch {
        if (!cancelled) {
          setAuthTokenProvider(null);
          setAuthPhase('ready');
        }
      }
    };

    initAuth();
    return () => {
      cancelled = true;
      if (unsubscribeAuth) unsubscribeAuth();
    };
  }, []);

  useEffect(() => {
    if (authPhase === 'ready') {
      bootstrap();
    }
  }, [authPhase, authUser?.id, bootstrap]);

  useEffect(() => {
    if (
      ssoPublic?.enabled &&
      ssoPublic?.enforce_sso &&
      ssoPublic?.configured &&
      !authUser?.is_admin &&
      adminMode
    ) {
      setAdminMode(false);
      if (window.location.hash.startsWith('#admin')) {
        window.history.pushState(null, '', window.location.pathname + window.location.search);
      }
    }
  }, [ssoPublic, authUser, adminMode]);

  useEffect(() => {
    const active = document.querySelector<HTMLElement>('.tabs-scroll-list [data-active="true"]');
    const list = active?.closest<HTMLElement>('.tabs-scroll-list');
    if (active && list) {
      const left = active.offsetLeft;
      const right = left + active.offsetWidth;
      if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
        list.scrollLeft = Math.max(0, right - list.clientWidth + 8);
      }
    }
  }, [activeTab, adminMode, adminSection, loading, isMobile]);

  useEffect(() => {
    const onHashChange = () => {
      const linkedId = consumeInitiativeHash();
      if (linkedId) {
        setAdminMode(false);
        setActiveTab('assumptions');
        setSelectedId(linkedId);
        setSelectedBcaId(null);
        refreshInitiativeData(linkedId).catch(() => {
          notifications.show({
            color: 'red',
            title: 'Initiative not found',
            message: 'The linked initiative may have been deleted.',
          });
        });
        return;
      }
      const route = parseRouteHash();
      if (route?.mode === 'admin') {
        setAdminMode(true);
        setAdminSection(route.adminSection);
        window.scrollTo({ top: 0 });
      } else if (route?.mode === 'workspace') {
        setAdminMode(false);
        setActiveDocSlug(route.docSlug || 'overview');
        setActiveTab(route.tab);
        window.scrollTo({ top: 0 });
      } else {
        setAdminMode(false);
        setActiveTab((prev) => (prev === 'docs' ? 'assumptions' : prev));
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [refreshInitiativeData]);

  const handleOpenDoc = useCallback((slug: string) => {
    const clean = slug || 'overview';
    setAdminMode(false);
    setActiveDocSlug(clean);
    setActiveTab('docs');
    closeNav();
    closeChatDrawer();
    const targetHash = `#docs/${encodeURIComponent(clean)}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    window.scrollTo({ top: 0 });
  }, [closeNav, closeChatDrawer]);

  const handleOpenAdmin = useCallback((section: AdminSection = 'users') => {
    setAdminSection(section);
    setAdminMode(true);
    closeNav();
    closeChatDrawer();
    const targetHash = `#admin/${section}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    window.scrollTo({ top: 0 });
  }, [closeNav, closeChatDrawer]);

  const handleSelectAdminSection = useCallback((section: AdminSection) => {
    setAdminSection(section);
    setAdminMode(true);
    closeNav();
    const targetHash = `#admin/${section}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    }
    window.scrollTo({ top: 0 });
  }, [closeNav]);

  const handleExitAdmin = useCallback(() => {
    setAdminMode(false);
    closeNav();
    if (activeTab === 'docs') {
      window.location.hash = `#docs/${encodeURIComponent(activeDocSlug)}`;
    } else if (window.location.hash.startsWith('#admin')) {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
    window.scrollTo({ top: 0 });
  }, [activeTab, activeDocSlug, closeNav]);

  const handleSignOut = useCallback(async () => {
    if (firebaseAuth) {
      await signOutFirebase(firebaseAuth);
    }
    setAuthUser(null);
    setSignedInEmail(null);
    setAuthError(null);
    setAdminMode(false);
    setInitiativeDetail(null);
    setInitiatives([]);
    setSelectedId(null);
    if (window.location.hash.startsWith('#admin')) {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  }, [firebaseAuth]);

  const handleTabChange = useCallback((value: string | null) => {
    const next = value || 'assumptions';
    setAdminMode(false);
    setActiveTab(next);
    if (next === 'docs') {
      const targetHash = `#docs/${encodeURIComponent(activeDocSlug)}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      }
    } else if (window.location.hash.startsWith('#admin') || window.location.hash.startsWith('#docs/')) {
      window.history.pushState(null, '', window.location.pathname + window.location.search);
    }
  }, [activeDocSlug]);

  const handleUseTemplateFromDoc = useCallback(
    (draft: Partial<InitiativeItemCreate>) => {
      if (!initiativeDetail) return;
      setAdminMode(false);
      setEditingItem(null);
      setDraftItem(draft);
      setActiveTab('assumptions');
      if (window.location.hash.startsWith('#admin') || window.location.hash.startsWith('#docs/')) {
        window.history.pushState(null, '', window.location.pathname + window.location.search);
      }
      openDrawer();
    },
    [initiativeDetail, openDrawer]
  );

  const handleCloseDrawer = useCallback(() => {
    setDraftItem(null);
    closeDrawer();
  }, [closeDrawer]);

  const activeBcaId = initiativeDetail?.active_bca_id ?? selectedBcaId ?? null;
  const bcas = initiativeDetail?.bcas ?? [];
  const activeBca =
    initiativeDetail?.active_bca ?? bcas.find((b) => b.id === activeBcaId) ?? null;

  const activeBcaRuns = useMemo(() => {
    if (!activeBcaId) return runs;
    const baselineId = bcas.find((b) => b.is_baseline)?.id ?? bcas[0]?.id ?? null;
    return runs.filter((r) => (r.bca_id ?? baselineId) === activeBcaId);
  }, [runs, activeBcaId, bcas]);

  const handleSelectInitiative = async (id: string) => {
    setSelectedId(id);
    setSelectedBcaId(null);
    setSimResult(null);
    setActiveComparison(null);
    closeNav();
    try {
      await refreshInitiativeData(id);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Failed to load initiative',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    }
  };

  const handleSelectBca = async (bcaId: string) => {
    if (!initiativeDetail || bcaId === activeBcaId) return;
    try {
      await refreshInitiativeData(initiativeDetail.id, bcaId);
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Failed to switch BCA',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    }
  };

  const handleOpenCreateBca = (cloneFromId: string | null = null) => {
    setBcaCloneSourceId(cloneFromId);
    openBcaModal();
  };

  const handleCreateBca = async (payload: BCACreate) => {
    if (!initiativeDetail) return;
    try {
      const created = await api.createBCA(initiativeDetail.id, payload);
      const list = await api.listInitiatives();
      setInitiatives(list);
      await refreshInitiativeData(initiativeDetail.id, created.id);
      notifications.show({
        color: 'teal',
        title: 'BCA scenario created',
        message: created.name,
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot create BCA',
        message: err instanceof Error ? err.message : 'Validation failed',
      });
      throw err;
    }
  };

  const handleUpdateBca = async (bcaId: string, payload: BCAUpdate) => {
    if (!initiativeDetail) return;
    try {
      await api.updateBCA(initiativeDetail.id, bcaId, payload);
      setInitiatives(await api.listInitiatives());
      await refreshInitiativeData(initiativeDetail.id, bcaId);
      notifications.show({
        color: 'teal',
        title: 'BCA assumptions saved',
        message: 'Scenario PV, NPV, and payback updated.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot update BCA',
        message: err instanceof Error ? err.message : 'Validation failed',
      });
      throw err;
    }
  };

  const handleDeleteBca = async (bcaId: string) => {
    if (!initiativeDetail) return;
    try {
      await api.deleteBCA(initiativeDetail.id, bcaId);
      setInitiatives(await api.listInitiatives());
      await refreshInitiativeData(initiativeDetail.id, null);
      notifications.show({
        color: 'gray',
        title: 'BCA deleted',
        message: 'Scenario and its runs removed.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot delete BCA',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
      throw err;
    }
  };

  const handleSetBaselineBca = async (bcaId: string) => {
    if (!initiativeDetail) return;
    try {
      await api.updateBCA(initiativeDetail.id, bcaId, { is_baseline: true });
      setInitiatives(await api.listInitiatives());
      await refreshInitiativeData(initiativeDetail.id, bcaId);
      notifications.show({
        color: 'teal',
        title: 'Baseline BCA updated',
        message: 'Initiative headline metrics now track this BCA.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot set baseline BCA',
        message: err instanceof Error ? err.message : 'Unexpected error',
      });
    }
  };

  const handleCreateInitiative = async (payload: InitiativeCreate) => {
    const created = await api.createInitiative(payload);
    const updatedList = await api.listInitiatives();
    setInitiatives(updatedList);
    setSelectedId(created.id);
    setSelectedBcaId(created.active_bca_id ?? null);
    setInitiativeDetail(created);
    setRuns([]);
    setSimResult(null);
    setComparisons([]);
    setActiveComparison(null);
    setActiveTab('assumptions');
    closeNav();
    notifications.show({
      color: 'teal',
      title: 'Initiative created',
      message: created.name,
    });
  };

  const handleUpdateInitiative = async (id: string, payload: InitiativeUpdate) => {
    try {
      await api.updateInitiative(id, payload);
      setInitiatives(await api.listInitiatives());
      await refreshInitiativeData(id, activeBcaId);
      notifications.show({
        color: 'teal',
        title: 'Assumptions saved',
        message: 'Deterministic PV, NPV, and payback updated.',
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Cannot save assumptions',
        message: err instanceof Error ? err.message : 'Validation failed',
      });
      throw err;
    }
  };

  const handleDeleteInitiative = async (id: string) => {
    await api.deleteInitiative(id);
    const remaining = await api.listInitiatives();
    setInitiatives(remaining);
    if (remaining.length > 0) {
      setSelectedId(remaining[0].id);
      setSelectedBcaId(null);
      setSimResult(null);
      setActiveComparison(null);
      await refreshInitiativeData(remaining[0].id);
    } else {
      setSelectedId(null);
      setSelectedBcaId(null);
      setInitiativeDetail(null);
      setRuns([]);
      setSimResult(null);
      setComparisons([]);
      setActiveComparison(null);
    }
    notifications.show({
      color: 'gray',
      title: 'Initiative deleted',
      message: 'Initiative and simulation runs removed.',
    });
  };

  const handleSaveItem = async (payload: InitiativeItemCreate, existingId?: string) => {
    if (!initiativeDetail) return;
    if (existingId) {
      await api.updateItem(existingId, payload);
      notifications.show({
        color: 'teal',
        title: 'Line item updated',
        message: payload.label,
      });
    } else {
      await api.addItem(initiativeDetail.id, payload, activeBcaId);
      notifications.show({
        color: 'teal',
        title: 'Line item added',
        message: payload.label,
      });
    }
    const [detail, list] = await Promise.all([
      api.getInitiative(initiativeDetail.id, activeBcaId),
      api.listInitiatives(),
    ]);
    setInitiativeDetail(detail);
    setInitiatives(list);
  };

  const handleMeasuresChanged = async () => {
    if (!initiativeDetail) return;
    setInitiativeDetail(await api.getInitiative(initiativeDetail.id, activeBcaId));
  };

  const handleDeleteItem = async (item: InitiativeItemOut) => {
    if (!initiativeDetail) return;
    await api.deleteItem(item.id);
    const [detail, list] = await Promise.all([
      api.getInitiative(initiativeDetail.id, activeBcaId),
      api.listInitiatives(),
    ]);
    setInitiativeDetail(detail);
    setInitiatives(list);
    notifications.show({
      color: 'gray',
      title: 'Line item removed',
      message: item.label,
    });
  };

  const handleRunSimulation = async (req: SimulationRequest) => {
    if (!initiativeDetail) return;
    setSimRunning(true);
    try {
      const targetBcaId = req.bca_id ?? activeBcaId;
      const result = await api.simulate(
        initiativeDetail.id,
        { ...req, bca_id: targetBcaId },
        targetBcaId
      );
      setSimResult(result);
      const [history, detail, list] = await Promise.all([
        api.listRuns(initiativeDetail.id),
        api.getInitiative(initiativeDetail.id, targetBcaId),
        api.listInitiatives(),
      ]);
      setRuns(history);
      setInitiativeDetail(detail);
      setInitiatives(list);
      setActiveTab('montecarlo');
      notifications.show({
        color: 'slateIndigo',
        title: 'Simulation complete',
        message: `${activeBca?.name || 'BCA'}: ${result.n_simulations.toLocaleString()} iterations in ${result.duration_ms.toFixed(1)} ms`,
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Simulation failed',
        message: err instanceof Error ? err.message : 'Unexpected simulation error',
      });
    } finally {
      setSimRunning(false);
    }
  };

  const handleRunComparison = async (req: BCACompareRequest) => {
    if (!initiativeDetail) return;
    setCompareRunning(true);
    try {
      const comp = await api.compareBCAs(initiativeDetail.id, req);
      setActiveComparison(comp);
      const [history, compHistory, detail, list] = await Promise.all([
        api.listRuns(initiativeDetail.id),
        api.listComparisons(initiativeDetail.id),
        api.getInitiative(initiativeDetail.id, activeBcaId),
        api.listInitiatives(),
      ]);
      setRuns(history);
      setComparisons(compHistory);
      setInitiativeDetail(detail);
      setInitiatives(list);
      setActiveTab('compare');
      notifications.show({
        color: 'teal',
        title: 'Monte Carlo comparison ready',
        message: `${comp.bca_a_name} vs ${comp.bca_b_name} (${comp.n_simulations.toLocaleString()} runs in ${comp.duration_ms.toFixed(0)} ms)`,
      });
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Comparison failed',
        message: err instanceof Error ? err.message : 'Unexpected comparison error',
      });
    } finally {
      setCompareRunning(false);
    }
  };

  const handleCreateCatalogEntry = async (payload: CatalogEntryCreate) => {
    const created = await api.createCatalogEntry(payload);
    setCatalog(await api.listCatalog());
    notifications.show({
      color: 'teal',
      title: 'Catalog template added',
      message: `${created.id} — ${created.name}. A documentation page was created for you to fill out.`,
    });
    handleOpenDoc(created.id);
  };

  const handleUpdateCatalogEntry = async (id: string, payload: CatalogEntryUpdate) => {
    const updated = await api.updateCatalogEntry(id, payload);
    handleCatalogEntryChanged(updated);
    notifications.show({ color: 'teal', title: 'Catalog template updated', message: `${updated.id} — ${updated.name}` });
    if (initiativeDetail) {
      // Line item values may change when a template's formula or defaults change.
      const [list] = await Promise.all([
        api.listInitiatives(),
        refreshInitiativeData(initiativeDetail.id, activeBcaId),
      ]);
      setInitiatives(list);
    }
  };

  const handleCatalogEntryChanged = (updated: CatalogEntry) => {
    setCatalog((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const existingValueStreams = useMemo(() => {
    const set = new Set<string>(['Software Delivery', 'Incident Response', 'Capability Enablement']);
    for (const item of initiativeDetail?.items || []) {
      set.add(item.value_stream);
    }
    return Array.from(set);
  }, [initiativeDetail]);

  const authRequired = Boolean(ssoPublic?.enabled && ssoPublic?.configured && ssoPublic?.enforce_sso);
  const canManageCatalog = authUser
    ? authUser.permissions.includes('catalog:manage')
    : !authRequired;
  const canAccessAdmin = !authRequired || Boolean(authUser?.is_admin);

  if (authPhase === 'checking') {
    return (
      <Center mih="100dvh" style={{ backgroundColor: 'var(--bg-canvas)' }}>
        <Stack align="center" gap="xs">
          <Loader size="md" />
          <Text size="sm" c="var(--text-muted)">
            Checking authentication...
          </Text>
        </Stack>
      </Center>
    );
  }

  if ((authPhase === 'unauthenticated' || authPhase === 'unauthorized') && ssoPublic) {
    return (
      <LoginGate
        ssoConfig={ssoPublic}
        firebaseAuth={firebaseAuth}
        mode={authPhase === 'unauthorized' ? 'unauthorized' : 'unauthenticated'}
        signedInEmail={signedInEmail}
        errorMessage={authError}
        onSignOut={handleSignOut}
      />
    );
  }

  if (showOptionalLoginModal && ssoPublic) {
    return (
      <LoginGate
        ssoConfig={ssoPublic}
        firebaseAuth={firebaseAuth}
        mode="unauthenticated"
        signedInEmail={signedInEmail}
        errorMessage={authError}
        onSignOut={handleSignOut}
        onDismissOptional={() => setShowOptionalLoginModal(false)}
      />
    );
  }

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: { base: '100%', sm: 290 }, breakpoint: 'sm', collapsed: { mobile: !navOpened } }}
      padding={{ base: 'xs', sm: 'md' }}
      styles={{
        main: { backgroundColor: 'var(--bg-canvas)' },
        header: { borderBottom: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-surface)' },
        navbar: { borderRight: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-surface)' },
      }}
    >
      <AppShell.Header px={{ base: 6, sm: 'md' }}>
        <Group h="100%" justify="space-between" wrap="nowrap" gap={4}>
          <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger
              opened={navOpened}
              onClick={toggleNav}
              hiddenFrom="sm"
              size="sm"
              color="var(--text-heading)"
              aria-label="Toggle navigation"
            />
            <div style={{ minWidth: 0 }}>
              <Title order={4} fz={{ base: 14, sm: 18 }} lh={1.15} style={{ whiteSpace: 'nowrap' }}>
                ValueStream BCA
              </Title>
              <Text size="xs" c="var(--text-muted)" visibleFrom="sm">
                {adminMode ? 'Administration Portal' : 'Cross-Domain Value Stream & Monte Carlo Platform'}
              </Text>
            </div>
          </Group>

          <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
            <ActionIcon
              type="button"
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="Toggle color scheme"
              onClick={() => setColorScheme(computedColorScheme === 'dark' ? 'light' : 'dark')}
            >
              {computedColorScheme === 'dark' ? (
                <IconSun size={16} color="var(--text-muted)" />
              ) : (
                <IconMoon size={16} color="var(--text-muted)" />
              )}
            </ActionIcon>

            {docsAgentAvailable &&
              (isMobile ? (
                <ActionIcon
                  type="button"
                  variant="subtle"
                  color="gray"
                  size="sm"
                  aria-label="Ask Docs Agent"
                  onClick={openChatDrawer}
                >
                  <IconMessageCircle size={16} color="var(--accent-primary)" />
                </ActionIcon>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  leftSection={<IconMessageCircle size={13} color="var(--accent-primary)" />}
                  onClick={openChatDrawer}
                >
                  Ask Docs
                </Button>
              ))}

            {canAccessAdmin && (
              adminMode ? (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  leftSection={<IconArrowLeft size={13} />}
                  onClick={handleExitAdmin}
                >
                  {isMobile ? 'Exit' : 'Workspace'}
                </Button>
              ) : isMobile ? (
                <ActionIcon
                  type="button"
                  variant="default"
                  size="sm"
                  aria-label="Admin Portal"
                  title="Admin Portal"
                  onClick={() => handleOpenAdmin(adminSection)}
                >
                  <IconSettings size={16} color="var(--text-body)" />
                </ActionIcon>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="default"
                  leftSection={<IconSettings size={13} />}
                  onClick={() => handleOpenAdmin(adminSection)}
                >
                  Admin
                </Button>
              )
            )}

            {authUser ? (
              <Menu shadow="md" width={230} position="bottom-end">
                <Menu.Target>
                  <Button
                    type="button"
                    size="xs"
                    variant="subtle"
                    color="gray"
                    px={6}
                    leftSection={
                      <Avatar
                        src={authUser.photo_url || null}
                        size={20}
                        radius="xl"
                        color="blue"
                      >
                        {(authUser.display_name || authUser.email || 'U').slice(0, 1).toUpperCase()}
                      </Avatar>
                    }
                  >
                    {!isMobile && (
                      <Text size="xs" fw={500} c="var(--text-heading)" lineClamp={1} maw={130}>
                        {authUser.display_name || authUser.email}
                      </Text>
                    )}
                  </Button>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Label>
                    <Stack gap={2}>
                      <Group justify="space-between" wrap="nowrap" gap={4}>
                        <Text size="xs" fw={600} c="var(--text-heading)" lineClamp={1}>
                          {authUser.display_name}
                        </Text>
                        <Badge size="xs" variant="light" color={authUser.is_admin ? 'teal' : 'blue'}>
                          {authUser.role_name}
                        </Badge>
                      </Group>
                      <Text size="xs" c="var(--text-muted)" lineClamp={1}>
                        {authUser.email}
                      </Text>
                    </Stack>
                  </Menu.Label>
                  <Menu.Divider />
                  {canAccessAdmin && !adminMode && (
                    <Menu.Item
                      leftSection={<IconSettings size={14} />}
                      onClick={() => handleOpenAdmin(adminSection)}
                    >
                      Admin Portal
                    </Menu.Item>
                  )}
                  <Menu.Item
                    color="red"
                    leftSection={<IconLogout size={14} />}
                    onClick={handleSignOut}
                  >
                    Sign Out
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : (
              ssoPublic?.enabled &&
              ssoPublic?.configured &&
              !ssoPublic.enforce_sso &&
              ssoPublic.provider === 'firebase' && (
                <Button
                  type="button"
                  size="xs"
                  variant="light"
                  leftSection={<IconLogin size={13} />}
                  onClick={() => setShowOptionalLoginModal(true)}
                >
                  {isMobile ? 'Sign In' : 'Sign In'}
                </Button>
              )
            )}
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p={{ base: 'sm', sm: 'md' }}>
        {adminMode ? (
          <AdminSidebar
            activeSection={adminSection}
            onSelectSection={handleSelectAdminSection}
            onExitAdmin={handleExitAdmin}
          />
        ) : (
          <InitiativeSidebar
            initiatives={initiatives}
            selectedId={selectedId}
            onSelect={handleSelectInitiative}
            onCreate={handleCreateInitiative}
            pendingApprovalIds={pendingApprovalIds}
          />
        )}
      </AppShell.Navbar>

      <AppShell.Main style={{ minWidth: 0 }}>
        {loading ? (
          <Center h={300}>
            <Stack align="center" gap="xs">
              <Loader size="md" />
              <Text size="sm" c="var(--text-muted)">
                Loading initiatives and catalog...
              </Text>
            </Stack>
          </Center>
        ) : loadError ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertCircle size={18} />}
            title="Backend connection error"
          >
            <Stack gap="xs">
              <Text size="sm">{loadError}</Text>
              <Button type="button" size="xs" variant="default" onClick={bootstrap} w="fit-content">
                Retry Connection
              </Button>
            </Stack>
          </Alert>
        ) : adminMode ? (
          <AdminPortal
            activeSection={adminSection}
            onSelectSection={handleSelectAdminSection}
            llmSettings={llmSettings}
            onSettingsUpdated={(next) => {
              setLlmSettings(next);
              setDocsAgentAvailable(Boolean(next.configured && next.verified));
              if (!(next.configured && next.verified)) {
                closeChatDrawer();
              }
            }}
            onOpenDocs={() => handleOpenDoc('overview')}
            onExitAdmin={handleExitAdmin}
          />
        ) : (
          <Tabs value={activeTab} onChange={handleTabChange}>
            <Tabs.List className="tabs-scroll-list" mb="md">
              <Tabs.Tab value="assumptions" leftSection={<IconLayoutDashboard size={15} />}>
                {isMobile ? 'Assumptions' : 'Initiatives & Assumptions'}
              </Tabs.Tab>
              <Tabs.Tab value="montecarlo" leftSection={<IconChartHistogram size={15} />}>
                {isMobile ? 'Monte Carlo' : 'Monte Carlo Certainty'}
              </Tabs.Tab>
              <Tabs.Tab value="compare" leftSection={<IconScale size={15} />}>
                {isMobile
                  ? 'Compare'
                  : bcas.length >= 2
                  ? `Compare BCAs (${bcas.length})`
                  : 'Compare BCAs'}
              </Tabs.Tab>
              <Tabs.Tab value="catalog" leftSection={<IconBooks size={15} />}>
                {isMobile ? `Catalog (${catalog.length})` : `Catalog Manager (${catalog.length})`}
              </Tabs.Tab>
              <Tabs.Tab value="docs" leftSection={<IconBook size={15} />}>
                {isMobile ? 'Docs' : 'Documentation'}
              </Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="assumptions">
              <KeepAlivePanel active={activeTab === 'assumptions'}>
                {!initiativeDetail ? (
                  <Paper withBorder p="md" bg="var(--bg-surface)">
                    <Text size="sm" c="var(--text-muted)">
                      Create a new initiative from the sidebar to begin modeling costs, benefits, and uncertainty.
                    </Text>
                  </Paper>
                ) : (
                  <Stack gap="md">
                    <InitiativeApprovalPanel
                      key={initiativeDetail.id}
                      initiativeId={initiativeDetail.id}
                      onStatusChange={async () => {
                        const id = initiativeDetail.id;
                        try {
                          const [list] = await Promise.all([
                            api.listInitiatives(),
                            refreshInitiativeData(id, activeBcaId),
                            refreshPendingApprovals(),
                          ]);
                          setInitiatives(list);
                        } catch {
                          /* panel already reported the action result */
                        }
                      }}
                    />
                    <BCASelectorBar
                      bcas={bcas}
                      activeBcaId={activeBcaId}
                      onSelectBca={handleSelectBca}
                      onOpenCreateBca={handleOpenCreateBca}
                      onOpenCompare={() => setActiveTab('compare')}
                      onExportExcel={() => api.downloadInitiativeExcel(initiativeDetail.id)}
                      onDownloadReport={() =>
                        activeBcaId ? api.downloadBcaReport(initiativeDetail.id, activeBcaId) : Promise.resolve()
                      }
                    />
                    <InitiativeSettingsBar
                      initiative={initiativeDetail}
                      activeBca={activeBca}
                      bcaCount={bcas.length}
                      onUpdate={handleUpdateInitiative}
                      onDelete={handleDeleteInitiative}
                      onUpdateBca={handleUpdateBca}
                      onDeleteBca={handleDeleteBca}
                      onSetBaseline={handleSetBaselineBca}
                    />
                    <DeterministicOverview
                      metrics={initiativeDetail.deterministic}
                      costStartYear={initiativeDetail.cost_start_year}
                    />
                    <LineItemsTable
                      items={initiativeDetail.items}
                      costStartYear={initiativeDetail.cost_start_year}
                      onAdd={() => {
                        setEditingItem(null);
                        setDraftItem(null);
                        openDrawer();
                      }}
                      onAddForCatalog={(catalogId) => {
                        setEditingItem(null);
                        setDraftItem({ catalog_id: catalogId });
                        openDrawer();
                      }}
                      onEdit={(item) => {
                        setDraftItem(null);
                        setEditingItem(item);
                        openDrawer();
                      }}
                      onDelete={handleDeleteItem}
                    />
                    <NonMonetaryBenefitsPanel
                      initiativeId={initiativeDetail.id}
                      measures={initiativeDetail.measures}
                      activeBca={activeBca}
                      bcas={bcas}
                      onChanged={handleMeasuresChanged}
                    />
                  </Stack>
                )}
              </KeepAlivePanel>
            </Tabs.Panel>

            <Tabs.Panel value="montecarlo">
              <KeepAlivePanel active={activeTab === 'montecarlo'}>
                {!initiativeDetail ? (
                  <Paper withBorder p="md" bg="var(--bg-surface)">
                    <Text size="sm" c="var(--text-muted)">
                      Select or create an initiative first.
                    </Text>
                  </Paper>
                ) : (
                  <Stack gap="md">
                    <BCASelectorBar
                      bcas={bcas}
                      activeBcaId={activeBcaId}
                      onSelectBca={handleSelectBca}
                      onOpenCreateBca={handleOpenCreateBca}
                      onOpenCompare={() => setActiveTab('compare')}
                      onExportExcel={() => api.downloadInitiativeExcel(initiativeDetail.id)}
                      onDownloadReport={() =>
                        activeBcaId
                          ? api.downloadBcaReport(
                              initiativeDetail.id,
                              activeBcaId,
                              // Report on the run being viewed, if it belongs to this BCA.
                              simResult && simResult.bca_id === activeBcaId ? simResult.run_id : null
                            )
                          : Promise.resolve()
                      }
                    />
                    <MonteCarloDashboard
                      initiative={initiativeDetail}
                      activeBca={activeBca}
                      bcaCount={bcas.length}
                      activeResult={simResult}
                      runs={activeBcaRuns}
                      running={simRunning}
                      onRunSimulation={handleRunSimulation}
                      onSelectHistoricalRun={(rec) => setSimResult(rec.summary)}
                      onOpenCompare={() => setActiveTab('compare')}
                    />
                  </Stack>
                )}
              </KeepAlivePanel>
            </Tabs.Panel>

            <Tabs.Panel value="compare">
              <KeepAlivePanel active={activeTab === 'compare'}>
                {!initiativeDetail ? (
                  <Paper withBorder p="md" bg="var(--bg-surface)">
                    <Text size="sm" c="var(--text-muted)">
                      Select or create an initiative first.
                    </Text>
                  </Paper>
                ) : (
                  <Stack gap="md">
                    <BCAComparisonDashboard
                      initiative={initiativeDetail}
                      bcas={bcas}
                      runs={runs}
                      comparisons={comparisons}
                      activeComparison={activeComparison}
                      running={compareRunning}
                      onRunComparison={handleRunComparison}
                      onSelectComparison={(rec) => setActiveComparison(rec.summary)}
                      onOpenCreateBca={handleOpenCreateBca}
                    />
                    <PairwisePlot initiativeId={initiativeDetail.id} bcas={bcas} measures={initiativeDetail.measures} />
                  </Stack>
                )}
              </KeepAlivePanel>
            </Tabs.Panel>

            <Tabs.Panel value="catalog">
              <KeepAlivePanel active={activeTab === 'catalog'}>
                <CatalogManager
                  catalog={catalog}
                  onCreateEntry={handleCreateCatalogEntry}
                  onUpdateEntry={handleUpdateCatalogEntry}
                  canManage={canManageCatalog}
                  onOpenDoc={handleOpenDoc}
                />
              </KeepAlivePanel>
            </Tabs.Panel>

            <Tabs.Panel value="docs">
              <KeepAlivePanel active={activeTab === 'docs'}>
                <DocsSite
                  catalog={catalog}
                  activeSlug={activeDocSlug}
                  onSelectSlug={handleOpenDoc}
                  hasActiveInitiative={Boolean(initiativeDetail)}
                  onUseTemplate={handleUseTemplateFromDoc}
                  llmSettings={llmSettings}
                  activeInitiative={initiativeDetail}
                  onOpenAdmin={() => handleOpenAdmin('ai')}
                  onOpenChatDrawer={docsAgentAvailable ? openChatDrawer : undefined}
                  canManageCatalog={canManageCatalog}
                  onCatalogEntryChanged={handleCatalogEntryChanged}
                />
              </KeepAlivePanel>
            </Tabs.Panel>
          </Tabs>
        )}

        <Drawer
          opened={chatDrawerOpen && docsAgentAvailable}
          onClose={closeChatDrawer}
          position="right"
          size={isMobile ? '100%' : 'lg'}
          padding={isMobile ? 'xs' : 'md'}
          title="ValueStream BCA Docs Agent"
        >
          <DocsAgentChat
            compact
            llmSettings={llmSettings}
            activeDocSlug={!adminMode && activeTab === 'docs' ? activeDocSlug : null}
            activeInitiative={initiativeDetail}
            onNavigateDoc={handleOpenDoc}
            onOpenAdmin={() => handleOpenAdmin('ai')}
          />
        </Drawer>

        {initiativeDetail && (
          <>
            <LineItemDrawer
              opened={drawerOpen}
              onClose={handleCloseDrawer}
              horizonYears={initiativeDetail.horizon_years}
              catalog={catalog}
              existingValueStreams={existingValueStreams}
              editingItem={editingItem}
              initialDraft={draftItem}
              onOpenDoc={handleOpenDoc}
              onSubmit={handleSaveItem}
            />
            <CreateBCAModal
              opened={bcaModalOpen}
              onClose={closeBcaModal}
              bcas={bcas}
              initialCloneFromId={bcaCloneSourceId}
              onSubmit={handleCreateBca}
            />
          </>
        )}
      </AppShell.Main>
    </AppShell>
  );
}

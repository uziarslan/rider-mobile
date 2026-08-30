import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Ionicons} from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import {io} from 'socket.io-client';
import {SafeAreaProvider, useSafeAreaInsets} from 'react-native-safe-area-context';
import {ApiError, apiRequest, configureApiSession, logoutRider, riderLogin} from './src/api';
import {API_BASE_URL} from './src/config';
import {
  applyAssignmentSocketEvent,
  assignmentAddressText,
  assignmentMapsQuery,
  assignmentWhatsAppUrl,
  type AssignmentSocketPayload,
} from './src/assignments';
import {getDeviceId, loadPendingActions, loadSession, savePendingActions} from './src/storage';
import {
  configureNotifications,
  ensureTrackingHealthy,
  flushLocationQueue,
  getCurrentLocation,
  getTrackingHealth,
  getTrackingReadiness,
  isTracking,
  openBatterySettings,
  openLocationSettings,
  openPowerSaverSettings,
  requestTrackingPermissions,
  startTracking,
  stopTracking,
  trackingHeartbeatPayload,
  type TrackingHealth,
  type TrackingMode,
} from './src/tracking';
import type {AuthSession, DeliveryAssignment, GeoLocation, PendingAction, RiderBootstrap} from './src/types';

type Tab = 'home' | 'deliveries' | 'profile';
type RiderAction = PendingAction['action'];
type AppDialog = {
  title: string;
  message: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  destructive?: boolean;
  onPrimary?: () => void | Promise<void>;
  onSecondary?: () => void | Promise<void>;
};
type ShowDialog = (dialog: AppDialog) => void;

const APP_VERSION = Constants.expoConfig?.version || Application.nativeApplicationVersion || '1.0.0';
const LAST_TAB_KEY = '@cenciss-rider/last-tab';
const ACTIONS: Record<string, {action: RiderAction; label: string; tone?: 'danger' | 'success'}[]> = {
  assigned: [{action: 'accept', label: 'Accept'}],
  accepted: [{action: 'picked_up', label: 'Picked Up'}],
  picked_up: [{action: 'delivered', label: 'Delivered', tone: 'success'}, {action: 'delivery_failed', label: 'Delivery Failed', tone: 'danger'}],
  delivered: [{action: 'returned_to_restaurant', label: 'Returned to Restaurant', tone: 'success'}],
  delivery_failed: [{action: 'returned_to_restaurant', label: 'Returned to Restaurant'}],
};
const NEXT_STATUS: Record<RiderAction, DeliveryAssignment['status']> = {
  accept: 'accepted', picked_up: 'picked_up', delivered: 'delivered', delivery_failed: 'delivery_failed', returned_to_restaurant: 'returned_to_restaurant',
};

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong.';
const humanStatus = (value?: string) => String(value || 'unknown').replaceAll('_', ' ');
const money = (value?: number) => `PKR ${Number(value || 0).toLocaleString('en-PK')}`;
const formatTime = (value?: string) => value ? new Date(value).toLocaleString() : '—';
const formatTrackingTime = (value?: string) => value ? new Date(value).toLocaleTimeString() : 'Waiting for signal';
const distanceText = (metres?: number) => Number(metres || 0) >= 1000 ? `${(Number(metres) / 1000).toFixed(1)} km` : `${Math.round(Number(metres || 0))} m`;
const currentLocation = async (): Promise<GeoLocation | undefined> => { try { return await getCurrentLocation(); } catch { return undefined; } };

const addressText = (assignment: DeliveryAssignment) => {
  return assignmentAddressText(assignment) || 'No address recorded';
};
const openMaps = (assignment: DeliveryAssignment, showDialog: ShowDialog) => {
  const query = assignmentMapsQuery(assignment);
  if (!query) {
    showDialog({title: 'Address unavailable', message: 'The cashier has not recorded a delivery address for this order.'});
    return;
  }
  Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`).catch(() => showDialog({title: 'Maps unavailable', message: 'Could not open a maps application.'}));
};
const openWhatsApp = (assignment: DeliveryAssignment, showDialog: ShowDialog) => {
  const url = assignmentWhatsAppUrl(assignment);
  if (!url) {
    showDialog({title: 'Phone unavailable', message: 'The cashier has not recorded a customer phone number for this order.'});
    return;
  }
  Linking.openURL(url).catch(() => showDialog({title: 'WhatsApp unavailable', message: 'Could not open WhatsApp on this phone.'}));
};

const Badge = ({children, tone = 'neutral'}: {children: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'info'}) => (
  <View style={[styles.badge, tone === 'good' && styles.badgeGood, tone === 'warn' && styles.badgeWarn, tone === 'info' && styles.badgeInfo]}>
    <Text style={[styles.badgeText, tone === 'good' && styles.badgeTextGood, tone === 'warn' && styles.badgeTextWarn, tone === 'info' && styles.badgeTextInfo]}>{children}</Text>
  </View>
);

const AppDialogModal = ({dialog, onClose}: {dialog: AppDialog | null; onClose: () => void}) => {
  if (!dialog) return null;
  const run = (callback?: () => void | Promise<void>) => {
    onClose();
    Promise.resolve(callback?.()).catch(() => {});
  };
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => run(dialog.onSecondary)}>
      <View style={styles.dialogOverlay}>
        <View style={styles.dialogCard}>
          <View style={[styles.dialogIcon, dialog.destructive && styles.dialogIconDanger]}><Ionicons name={dialog.destructive ? 'warning-outline' : 'information-circle-outline'} size={26} color={dialog.destructive ? '#dc2626' : '#4f46e5'} /></View>
          <Text style={styles.dialogTitle}>{dialog.title}</Text>
          <Text style={styles.dialogMessage}>{dialog.message}</Text>
          <View style={styles.dialogActions}>
            {dialog.secondaryLabel ? <Pressable onPress={() => run(dialog.onSecondary)} style={styles.dialogSecondaryButton}><Text style={styles.dialogSecondaryText}>{dialog.secondaryLabel}</Text></Pressable> : null}
            <Pressable onPress={() => run(dialog.onPrimary)} style={[styles.dialogPrimaryButton, dialog.destructive && styles.dialogPrimaryDanger]}><Text style={styles.dialogPrimaryText}>{dialog.primaryLabel || 'OK'}</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const DeliveryCard = ({assignment, busy, onAction, onViewDetails, showDialog}: {assignment: DeliveryAssignment; busy: boolean; onAction: (assignment: DeliveryAssignment, action: RiderAction) => void; onViewDetails: (assignment: DeliveryAssignment) => void; showDialog: ShowDialog}) => {
  const actions = ACTIONS[assignment.status] || [];
  return (
    <View style={styles.deliveryCard}>
      <Pressable onPress={() => onViewDetails(assignment)} style={styles.rowBetween} accessibilityRole="button" accessibilityLabel={`View order ${assignment.orderNumber} information`}>
        <View style={styles.flexOne}><Text style={styles.eyebrow}>DELIVERY ORDER</Text><Text style={styles.orderNumber}>{assignment.orderNumber}</Text></View>
        <Badge tone={assignment.status === 'delivery_failed' ? 'warn' : assignment.active ? 'info' : 'good'}>{humanStatus(assignment.status)}</Badge>
      </Pressable>
      <View style={styles.divider} />
      <Text style={styles.customerName}>{assignment.customerName || 'Delivery customer'}</Text>
      {assignment.customerPhone ? <><View style={styles.customerPhoneRow}><Ionicons name="call-outline" size={16} color="#475569" /><Text style={styles.customerPhone}>{assignment.customerPhone}</Text></View><View style={styles.contactActions}><Pressable onPress={() => Linking.openURL(`tel:${assignment.customerPhone}`).catch(() => showDialog({title: 'Phone unavailable', message: 'Could not open the phone application.'}))} style={styles.callButton}><Text style={styles.callButtonText}>Call</Text></Pressable><Pressable onPress={() => openWhatsApp(assignment, showDialog)} style={styles.whatsappButton}><Text style={styles.whatsappButtonText}>WhatsApp</Text></Pressable></View></> : null}
      <Text style={styles.address}>⌖ {addressText(assignment)}</Text>
      {(assignment.items || []).length > 0 && <View style={styles.orderItemsBox}>
        <View style={styles.orderItemsHeader}><Text style={styles.orderItemsTitle}>ORDER ITEMS</Text><Text style={styles.orderItemsCount}>{assignment.items?.length}</Text></View>
        {assignment.items?.map((item, index) => <View key={`${item.menuItem || item.name}-${item.variation?.id || item.variation?.name || ''}-${index}`} style={[styles.orderItemRow, index > 0 && styles.orderItemDivider]}>
          <View style={styles.orderItemMain}><Text style={styles.orderItemName}>{item.qty} × {item.name}</Text>{item.variation?.name ? <Text style={styles.orderItemVariation}>{item.variation.name}</Text> : null}{item.notes ? <Text style={styles.orderItemNote}>{item.notes}</Text> : null}</View>
          <Text style={styles.orderItemAmount}>{money(item.lineTotal)}</Text>
        </View>)}
      </View>}
      <View style={styles.orderMeta}><Text style={styles.metaText}>{money(assignment.totalAmount)}</Text><Text style={styles.metaText}>Assigned {formatTime(assignment.assignedAt)}</Text></View>
      {assignment.notes ? <View style={styles.noteBox}><Text style={styles.noteLabel}>ORDER NOTE</Text><Text style={styles.noteText}>{assignment.notes}</Text></View> : null}
      <Pressable style={styles.detailsButton} onPress={() => onViewDetails(assignment)}><Text style={styles.detailsButtonText}>View Order Information</Text></Pressable>
      <Pressable style={styles.mapButton} onPress={() => openMaps(assignment, showDialog)}><Text style={styles.mapButtonText}>Open in Google Maps</Text></Pressable>
      {actions.length > 0 && <View style={styles.actions}>{actions.map(item => (
        <Pressable key={item.action} disabled={busy} onPress={() => onAction(assignment, item.action)} style={({pressed}) => [styles.actionButton, item.tone === 'danger' && styles.actionDanger, item.tone === 'success' && styles.actionSuccess, (busy || pressed) && styles.buttonDisabled]}>
          <Text style={styles.actionText}>{busy ? 'Updating…' : item.label}</Text>
        </Pressable>
      ))}</View>}
    </View>
  );
};

const OrderDetailsModal = ({assignment, loading, onClose, showDialog}: {assignment: DeliveryAssignment | null; loading: boolean; onClose: () => void; showDialog: ShowDialog}) => {
  const insets = useSafeAreaInsets();
  if (!assignment) return null;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.detailsPage, {paddingTop: insets.top + 12, paddingBottom: Math.max(insets.bottom, 12)}]}>
        <View style={styles.detailsTopBar}><View style={styles.flexOne}><Text style={styles.eyebrow}>DELIVERY ORDER</Text><Text style={styles.detailsOrderNumber}>{assignment.orderNumber}</Text></View><Pressable onPress={onClose} style={styles.detailsCloseIcon}><Text style={styles.detailsCloseIconText}>×</Text></Pressable></View>
        {loading ? <View style={styles.detailsLoading}><ActivityIndicator color="#4f46e5" /><Text style={styles.detailsLoadingText}>Loading latest order information…</Text></View> : null}
        <ScrollView style={styles.detailsScroll} contentContainerStyle={styles.detailsContent}>
          <View style={styles.detailsSection}><Text style={styles.detailsSectionTitle}>STATUS</Text><Badge tone={assignment.status === 'delivery_failed' ? 'warn' : assignment.active ? 'info' : 'good'}>{humanStatus(assignment.status)}</Badge></View>
          <View style={styles.detailsSection}><Text style={styles.detailsSectionTitle}>CUSTOMER</Text><Text style={styles.detailsCustomer}>{assignment.customerName || 'No customer name recorded'}</Text>{assignment.customerPhone ? <><View style={styles.customerPhoneRow}><Ionicons name="call-outline" size={16} color="#475569" /><Text style={styles.customerPhone}>{assignment.customerPhone}</Text></View><View style={styles.contactActions}><Pressable onPress={() => Linking.openURL(`tel:${assignment.customerPhone}`).catch(() => showDialog({title: 'Phone unavailable', message: 'Could not open the phone application.'}))} style={styles.callButton}><Text style={styles.callButtonText}>Call</Text></Pressable><Pressable onPress={() => openWhatsApp(assignment, showDialog)} style={styles.whatsappButton}><Text style={styles.whatsappButtonText}>WhatsApp</Text></Pressable></View></> : <Text style={styles.detailsMissing}>No customer phone recorded</Text>}</View>
          <View style={styles.detailsSection}><Text style={styles.detailsSectionTitle}>DELIVERY ADDRESS</Text><Text style={styles.detailsAddress}>{addressText(assignment)}</Text><Pressable style={styles.mapButton} onPress={() => openMaps(assignment, showDialog)}><Text style={styles.mapButtonText}>Open in Google Maps</Text></Pressable></View>
          <View style={styles.detailsSection}><View style={styles.orderItemsHeader}><Text style={styles.detailsSectionTitle}>ORDER ITEMS</Text><Text style={styles.orderItemsCount}>{assignment.items?.length || 0}</Text></View>
            {(assignment.items || []).length > 0 ? assignment.items?.map((item, index) => <View key={`${item.menuItem || item.name}-${item.variation?.id || item.variation?.name || ''}-${index}`} style={[styles.detailsItemRow, index > 0 && styles.orderItemDivider]}><View style={styles.orderItemMain}><Text style={styles.orderItemName}>{item.qty} × {item.name}</Text>{item.variation?.name ? <Text style={styles.orderItemVariation}>{item.variation.name}</Text> : null}{item.notes ? <Text style={styles.orderItemNote}>{item.notes}</Text> : null}</View><Text style={styles.orderItemAmount}>{money(item.lineTotal)}</Text></View>) : <Text style={styles.detailsMissing}>No order items were returned by the server.</Text>}
          </View>
          {assignment.notes ? <View style={styles.detailsSection}><Text style={styles.detailsSectionTitle}>ORDER NOTE</Text><Text style={styles.noteText}>{assignment.notes}</Text></View> : null}
          <View style={styles.detailsTotal}><Text style={styles.detailsTotalLabel}>Order total</Text><Text style={styles.detailsTotalValue}>{money(assignment.totalAmount)}</Text></View>
        </ScrollView>
        <Pressable onPress={onClose} style={styles.detailsCloseButton}><Text style={styles.detailsCloseButtonText}>Close</Text></Pressable>
      </View>
    </Modal>
  );
};

const LoginScreen = ({onLogin, showDialog}: {onLogin: (session: AuthSession) => void; showDialog: ShowDialog}) => {
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    if (!email.trim() || !password) { showDialog({title: 'Missing details', message: 'Enter your rider email and password.'}); return; }
    setLoading(true);
    try { onLogin(await riderLogin(email, password)); } catch (error) { showDialog({title: 'Sign in failed', message: errorMessage(error)}); } finally { setLoading(false); }
  };
  return (
    <ScrollView contentContainerStyle={[styles.loginPage, {paddingTop: insets.top + 42, paddingBottom: insets.bottom + 24}]} keyboardShouldPersistTaps="handled">
      <View style={styles.logoMark}><Image source={require('./assets/brand-mark.png')} resizeMode="contain" style={styles.loginLogo} /></View><Text style={styles.brand}>CENCISS</Text><Text style={styles.loginTitle}>Delivery</Text>
      <Text style={styles.loginSubtitle}>Sign in with the rider account created for your outlet.</Text>
      <View style={styles.loginCard}>
        <Text style={styles.inputLabel}>EMAIL</Text><TextInput style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder="rider@restaurant.com" placeholderTextColor="#94a3b8" />
        <Text style={styles.inputLabel}>PASSWORD</Text><TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="Your password" placeholderTextColor="#94a3b8" />
        <Pressable disabled={loading} onPress={submit} style={({pressed}) => [styles.primaryButton, (pressed || loading) && styles.buttonDisabled]}>{loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryButtonText}>Sign In</Text>}</Pressable>
      </View>
      <Text style={styles.loginFootnote}>This app works only when Rider Tracking is approved for your outlet.</Text>
    </ScrollView>
  );
};

const RiderApp = () => {
  const insets = useSafeAreaInsets();
  const [session, setSession] = useState<AuthSession | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [bootstrap, setBootstrap] = useState<RiderBootstrap | null>(null);
  const [orders, setOrders] = useState<DeliveryAssignment[]>([]);
  const [tab, setTab] = useState<Tab>('home');
  const [refreshing, setRefreshing] = useState(false);
  const [dutyBusy, setDutyBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState('');
  const [trackingMode, setTrackingMode] = useState<TrackingMode>('stopped');
  const [trackingHealth, setTrackingHealth] = useState<TrackingHealth>({mode: 'stopped', queueDepth: 0});
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [businessDate, setBusinessDate] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<DeliveryAssignment | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [dialog, setDialog] = useState<AppDialog | null>(null);
  const showDialog = useCallback<ShowDialog>((next) => setDialog(next), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  useEffect(() => {
    Promise.all([loadSession(), loadPendingActions(), AsyncStorage.getItem(LAST_TAB_KEY)]).then(([saved, pending, savedTab]) => {
      configureApiSession(saved, setSession); setSession(saved); setPendingActions(pending); if (savedTab === 'deliveries' || savedTab === 'profile') setTab(savedTab);
    }).finally(() => setInitializing(false));
  }, []);
  const selectTab = (next: Tab) => { setTab(next); AsyncStorage.setItem(LAST_TAB_KEY, next).catch(() => {}); };

  const refreshAll = useCallback(async ({quiet = false}: {quiet?: boolean} = {}) => {
    if (!session) return;
    if (!quiet) setRefreshing(true);
    try {
      const [bootstrapResponse, ordersResponse] = await Promise.all([
        apiRequest<{data: RiderBootstrap}>('/api/rider/bootstrap'), apiRequest<{data: DeliveryAssignment[]; businessDate?: string}>('/api/rider/orders?history=true'),
      ]);
      const nextOrders = ordersResponse.data || [];
      setBootstrap(bootstrapResponse.data); setBusinessDate(ordersResponse.businessDate || bootstrapResponse.data.businessDate || ''); setOrders(nextOrders);
      setSelectedOrder(current => current && !nextOrders.some(order => order._id === current._id) ? null : current);
      const currentMode = await isTracking(); setTrackingMode(currentMode);
      if (bootstrapResponse.data.shift) {
        try {
          const repaired = await ensureTrackingHealthy();
          setTrackingMode(repaired.mode);
          await flushLocationQueue();
        } catch { /* The health card exposes permission/task errors and repair actions. */ }
      }
      if (!bootstrapResponse.data.shift && currentMode !== 'stopped') { await stopTracking(); setTrackingMode('stopped'); }
      setTrackingHealth(await getTrackingHealth());
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'FEATURE_DISABLED' || error.status === 403)) {
        await stopTracking().catch(() => {}); setTrackingMode('stopped'); showDialog({title: 'Rider Tracking disabled', message: error.message, primaryLabel: 'Sign Out', destructive: true, onPrimary: async () => { await logoutRider(); setSession(null); }});
      } else if (!quiet) showDialog({title: 'Refresh failed', message: errorMessage(error)});
    } finally { if (!quiet) setRefreshing(false); }
  }, [session, showDialog]);

  useEffect(() => {
    if (!session) return undefined;
    configureApiSession(session, setSession);
    const initialRefresh = setTimeout(() => { refreshAll(); }, 0);
    const socket = io(API_BASE_URL, {transports: ['websocket', 'polling'], auth: {token: session.accessToken}, reconnection: true});
    const join = () => { socket.emit('rider:join'); refreshAll({quiet: true}); };
    const updateFromSocket = (payload?: AssignmentSocketPayload) => {
      const hasFullAssignment = Boolean(payload?._id && payload.orderNumber && payload.status);
      if (!hasFullAssignment) { refreshAll({quiet: true}); return; }
      setOrders(current => applyAssignmentSocketEvent(current, payload).filter(order => order.active || !businessDate || !order.businessDate || order.businessDate === businessDate));
      setBootstrap(current => current ? {...current, assignments: applyAssignmentSocketEvent(current.assignments || [], payload)} : current);
      setSelectedOrder(current => current ? applyAssignmentSocketEvent([current], payload)[0] : current);
    };
    socket.on('connect', join);
    if (socket.connected) join();
    const reminder = (payload?: {orderNumber?: string}) => {
      showDialog({title: 'Delivery reminder', message: `Please review order ${payload?.orderNumber || ''}.`.trim(), primaryLabel: 'View Deliveries', onPrimary: () => selectTab('deliveries')});
      refreshAll({quiet: true});
    };
    ['rider-assignment:new', 'rider-assignment:updated', 'rider-assignment:reassigned'].forEach(event => socket.on(event, updateFromSocket));
    socket.on('rider-tracking:disabled', () => refreshAll({quiet: true}));
    socket.on('rider-assignment:reminder', reminder);
    const appStateSubscription = AppState.addEventListener('change', state => { if (state === 'active') refreshAll({quiet: true}); });
    const timer = setInterval(() => refreshAll({quiet: true}), 30_000);
    return () => { clearTimeout(initialRefresh); clearInterval(timer); appStateSubscription.remove(); socket.disconnect(); };
  }, [businessDate, refreshAll, session, showDialog]);

  useEffect(() => {
    if (!session) return;
    getDeviceId().then(async deviceId => { try {
      await configureNotifications();
      const notificationPermission = await Notifications.getPermissionsAsync();
      const tracking = await trackingHeartbeatPayload();
      await apiRequest('/api/rider/devices/register', {method: 'POST', body: JSON.stringify({...tracking, deviceId, manufacturer: Device.manufacturer, model: Device.modelName, osVersion: Device.osVersion, appVersion: APP_VERSION, notificationsEnabled: notificationPermission.granted})});
    } catch { /* Re-register on the next app launch. */ } });
  }, [session]);

  useEffect(() => {
    if (!session || !bootstrap?.shift) return undefined;
    const heartbeat = async () => { try { const payload = await trackingHeartbeatPayload(); setTrackingMode(payload.trackingMode); setTrackingHealth(await getTrackingHealth()); await apiRequest('/api/rider/heartbeat', {method: 'POST', body: JSON.stringify(payload)}); } catch { /* Background location uploads remain the primary liveness signal. */ } };
    heartbeat(); const timer = setInterval(heartbeat, 60_000); return () => clearInterval(timer);
  }, [bootstrap?.shift, session]);

  const syncPending = useCallback(async () => {
    if (!session || !(await NetInfo.fetch()).isConnected) return;
    const queued = await loadPendingActions(); if (!queued.length) return; const remaining: PendingAction[] = [];
    for (const item of queued) { try { await apiRequest(`/api/rider/orders/${item.assignmentId}/action`, {method: 'PATCH', body: JSON.stringify({action: item.action, clientEventId: item.clientEventId, location: item.location})}); } catch (error) { if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) remaining.push(item); } }
    setPendingActions(remaining); await savePendingActions(remaining); if (remaining.length !== queued.length) refreshAll({quiet: true});
  }, [refreshAll, session]);
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      if (state.isConnected) {
        syncPending();
        flushLocationQueue().catch(() => {});
      }
    });
    const initialSync = setTimeout(() => { syncPending(); }, 0);
    return () => { clearTimeout(initialSync); unsubscribe(); };
  }, [syncPending]);

  const viewOrderDetails = async (assignment: DeliveryAssignment) => {
    setSelectedOrder(assignment);
    setDetailsLoading(true);
    try {
      const response = await apiRequest<{data: DeliveryAssignment}>(`/api/rider/orders/${assignment._id}`);
      setSelectedOrder(response.data);
      setOrders(current => applyAssignmentSocketEvent(current, response.data));
    } catch (error) {
      showDialog({title: 'Could not load order information', message: errorMessage(error)});
    } finally {
      setDetailsLoading(false);
    }
  };

  const startDuty = async () => {
    setDutyBusy(true);
    try {
      const permissions = await requestTrackingPermissions();
      if (!permissions.granted) { showDialog({title: 'Location required', message: 'Set Location to “Allow all the time” with precise location enabled so the full route continues while the phone is locked.', primaryLabel: 'Open Settings', secondaryLabel: 'Cancel', onPrimary: openLocationSettings}); return; }
      const readiness = await getTrackingReadiness();
      if (!readiness.preciseLocation) {
        showDialog({title: 'Precise location required', message: 'Enable precise location for Cenciss Delivery, then press Start Duty again.', primaryLabel: 'Open Settings', secondaryLabel: 'Cancel', onPrimary: openLocationSettings});
        return;
      }
      if (readiness.backgroundAvailable && readiness.batteryOptimizationEnabled) {
        showDialog({title: 'Unrestricted battery required', message: 'Android is allowed to suspend Cenciss Delivery after the screen is locked. Allow the app to ignore battery optimization, then press Start Duty again.', primaryLabel: 'Allow Background Tracking', secondaryLabel: 'Cancel', onPrimary: openBatterySettings});
        return;
      }
      if (readiness.backgroundAvailable && readiness.lowPowerMode) {
        showDialog({title: 'Turn off Battery Saver', message: 'Battery Saver can delay or stop live GPS updates. Turn it off, then press Start Duty again.', primaryLabel: 'Open Battery Saver', secondaryLabel: 'Cancel', onPrimary: openPowerSaverSettings});
        return;
      }
      const location = await currentLocation(); if (!location) throw new Error('Could not get a precise GPS location. Move outdoors and try again.');
      await apiRequest('/api/rider/shifts/start', {method: 'POST', body: JSON.stringify({location})});
      try {
        const mode = await startTracking();
        setTrackingMode(mode);
        setTrackingHealth(await getTrackingHealth());
        await apiRequest('/api/rider/heartbeat', {method: 'POST', body: JSON.stringify(await trackingHeartbeatPayload())});
        if (mode === 'foreground') showDialog({title: 'Expo Go development mode', message: 'GPS is being sent while this app stays open. Locked-screen background tracking becomes active in the installed APK build.'});
      } catch (error) { await apiRequest('/api/rider/shifts/end', {method: 'POST', body: JSON.stringify({location, reason: 'Tracking service could not start'})}).catch(() => {}); throw error; }
      await refreshAll({quiet: true});
    } catch (error) { showDialog({title: 'Could not start duty', message: errorMessage(error)}); } finally { setDutyBusy(false); }
  };
  const endDuty = async () => {
    const activeOrder = orders.find(order => order.active); if (activeOrder) { showDialog({title: 'Delivery still active', message: `Complete or return order ${activeOrder.orderNumber} before ending duty.`}); return; }
    showDialog({title: 'End duty?', message: 'Your continuous GPS tracking will stop.', primaryLabel: 'End Duty', secondaryLabel: 'Cancel', destructive: true, onPrimary: async () => {
      setDutyBusy(true); try { await flushLocationQueue(); const location = await currentLocation(); await apiRequest('/api/rider/shifts/end', {method: 'POST', body: JSON.stringify({location, reason: 'Rider ended duty'})}); await stopTracking(); setTrackingMode('stopped'); setTrackingHealth(await getTrackingHealth()); await refreshAll({quiet: true}); } catch (error) { showDialog({title: 'Could not end duty', message: errorMessage(error)}); } finally { setDutyBusy(false); }
    }});
  };
  const repairTracking = async () => {
    setDutyBusy(true);
    try {
      const permissions = await requestTrackingPermissions();
      if (!permissions.granted) {
        showDialog({title: 'Location required', message: 'Set Location to “Allow all the time” with precise location enabled.', primaryLabel: 'Open Settings', secondaryLabel: 'Cancel', onPrimary: openLocationSettings});
        return;
      }
      const readiness = await getTrackingReadiness();
      if (!readiness.preciseLocation) {
        showDialog({title: 'Precise location required', message: 'Enable precise location for Cenciss Delivery.', primaryLabel: 'Open Settings', secondaryLabel: 'Cancel', onPrimary: openLocationSettings});
        return;
      }
      if (readiness.backgroundAvailable && readiness.batteryOptimizationEnabled) {
        showDialog({title: 'Unrestricted battery required', message: 'Allow Cenciss Delivery to ignore battery optimization, then return to the app. Tracking will be checked again automatically.', primaryLabel: 'Allow Background Tracking', secondaryLabel: 'Cancel', onPrimary: openBatterySettings});
        return;
      }
      if (readiness.backgroundAvailable && readiness.lowPowerMode) {
        showDialog({title: 'Turn off Battery Saver', message: 'Battery Saver can suppress background GPS callbacks.', primaryLabel: 'Open Battery Saver', secondaryLabel: 'Cancel', onPrimary: openPowerSaverSettings});
        return;
      }
      const repaired = await ensureTrackingHealthy();
      setTrackingMode(repaired.mode);
      await flushLocationQueue();
      await apiRequest('/api/rider/heartbeat', {method: 'POST', body: JSON.stringify(await trackingHeartbeatPayload())});
      setTrackingHealth(await getTrackingHealth());
      showDialog({title: 'Tracking ready', message: repaired.restarted ? 'The location service was restarted and is sending again.' : 'The location service is already active.'});
    } catch (error) {
      setTrackingHealth(await getTrackingHealth());
      showDialog({title: 'Tracking repair failed', message: errorMessage(error), primaryLabel: 'Open Settings', secondaryLabel: 'Close', onPrimary: openLocationSettings});
    } finally {
      setDutyBusy(false);
    }
  };
  const performAction = async (assignment: DeliveryAssignment, action: RiderAction) => {
    if (action === 'delivery_failed') { showDialog({title: 'Mark delivery failed?', message: 'Use this only when the delivery could not be completed.', primaryLabel: 'Delivery Failed', secondaryLabel: 'Cancel', destructive: true, onPrimary: () => submitAction(assignment, action)}); return; }
    if (action === 'returned_to_restaurant') { showDialog({title: 'Confirm restaurant return?', message: 'You must be physically inside the restaurant geofence. The cashier can correct or reopen an early return.', primaryLabel: 'Confirm Return', secondaryLabel: 'Cancel', onPrimary: () => submitAction(assignment, action)}); return; }
    submitAction(assignment, action);
  };
  const submitAction = async (assignment: DeliveryAssignment, action: RiderAction) => {
    setActionBusy(assignment._id);
    const pending: PendingAction = {id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, assignmentId: assignment._id, action, clientEventId: `${assignment._id}-${Date.now()}-${Math.random().toString(36).slice(2)}`, location: await currentLocation(), queuedAt: new Date().toISOString()};
    try {
      if (!(await NetInfo.fetch()).isConnected) throw new ApiError('No connection to the tracking server.');
      await apiRequest(`/api/rider/orders/${assignment._id}/action`, {method: 'PATCH', body: JSON.stringify(pending)}); await refreshAll({quiet: true});
    } catch (error) {
      if (error instanceof ApiError && error.status === 0) {
        const next = [...pendingActions, pending]; setPendingActions(next); await savePendingActions(next);
        setOrders(current => current.map(order => order._id === assignment._id ? {...order, status: NEXT_STATUS[action], active: NEXT_STATUS[action] !== 'returned_to_restaurant'} : order));
        showDialog({title: 'Saved offline', message: 'This action is queued and will sync automatically when the connection returns.'});
      } else showDialog({title: 'Action not saved', message: errorMessage(error)});
    } finally { setActionBusy(''); }
  };
  const signOut = () => {
    if (bootstrap?.shift) { showDialog({title: 'End duty first', message: 'You cannot sign out while duty tracking is active.'}); return; }
    showDialog({title: 'Sign out?', message: 'This removes the rider session from this phone.', primaryLabel: 'Sign Out', secondaryLabel: 'Cancel', destructive: true, onPrimary: async () => { await stopTracking().catch(() => {}); await logoutRider(); setSession(null); }});
  };

  if (initializing) return <View style={styles.loadingPage}><StatusBar barStyle="dark-content" /><ActivityIndicator size="large" color="#4f46e5" /><Text style={styles.loadingText}>Loading Cenciss Delivery…</Text></View>;
  if (!session) return <><LoginScreen onLogin={next => { configureApiSession(next, setSession); setSession(next); }} showDialog={showDialog} /><AppDialogModal dialog={dialog} onClose={closeDialog} /></>;
  const activeOrders = orders.filter(order => order.active); const historyOrders = orders.filter(order => !order.active); const currentOrder = activeOrders[0];
  const trackingActive = trackingMode !== 'stopped';
  const batteryRestricted = trackingHealth.batteryOptimizationEnabled === true;
  const lowPowerRestricted = trackingHealth.lowPowerMode === true;
  const trackingNeedsAttention = Boolean(bootstrap?.shift && (trackingMode === 'stopped' || trackingHealth.lastError || batteryRestricted || lowPowerRestricted));
  const trackingWarningMessage = batteryRestricted
    ? 'Battery optimization is enabled. Android may stop tracking when the phone is locked.'
    : lowPowerRestricted
      ? 'Battery Saver is enabled and can delay background GPS updates.'
      : trackingHealth.lastError || 'The Android location service is stopped.';
  const trackingWarningAction = batteryRestricted ? openBatterySettings : lowPowerRestricted ? openPowerSaverSettings : repairTracking;

  return (
    <View style={styles.appShell}>
      <StatusBar barStyle="dark-content" />
      <View style={[styles.header, {paddingTop: insets.top + 10}]}><View><Text style={styles.headerBrand}>CENCISS DELIVERY</Text><Text style={styles.headerOutlet}>{bootstrap?.outlet?.name || session.user.outletCode || 'Your outlet'}</Text></View><Badge tone={bootstrap?.shift ? 'good' : 'neutral'}>{bootstrap?.shift ? 'ON DUTY' : 'OFF DUTY'}</Badge></View>
      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => refreshAll()} tintColor="#4f46e5" />}>
        {pendingActions.length > 0 && <View style={styles.offlineBanner}><Text style={styles.offlineTitle}>↻ {pendingActions.length} action{pendingActions.length === 1 ? '' : 's'} waiting to sync</Text><Text style={styles.offlineText}>Keep the app installed; they will upload automatically.</Text></View>}
        {trackingNeedsAttention && <View style={styles.trackingWarning}><Text style={styles.trackingWarningTitle}>Tracking needs attention</Text><Text style={styles.trackingWarningText}>{trackingWarningMessage}</Text><Pressable disabled={dutyBusy} onPress={trackingWarningAction} style={styles.trackingRepairButton}><Text style={styles.trackingRepairText}>{dutyBusy ? 'Checking…' : batteryRestricted ? 'Allow Background Tracking' : lowPowerRestricted ? 'Open Battery Saver' : 'Repair Tracking'}</Text></Pressable></View>}
        {tab === 'home' && <>
          <View style={[styles.dutyCard, bootstrap?.shift && styles.dutyCardActive]}>
            <View style={styles.rowBetween}><View style={styles.flexOne}><Text style={[styles.eyebrow, bootstrap?.shift && styles.eyebrowActive]}>{bootstrap?.shift ? 'CURRENT SHIFT' : 'READY FOR DUTY'}</Text><Text style={[styles.dutyTitle, bootstrap?.shift && styles.dutyTitleActive]}>{bootstrap?.shift ? 'Tracking is active' : 'Start when you are ready'}</Text></View><View style={[styles.trackingDot, trackingActive && styles.trackingDotActive]} /></View>
            {bootstrap?.shift ? <><View style={styles.shiftStats}><View><Text style={styles.shiftValue}>{distanceText(bootstrap.shift.distanceMeters)}</Text><Text style={styles.shiftLabel}>Distance</Text></View><View><Text style={styles.shiftValue}>{bootstrap.shift.pointCount || 0}</Text><Text style={styles.shiftLabel}>GPS points</Text></View><View><Text style={styles.shiftValue}>{bootstrap.shift.inOutletGeofence == null ? '—' : bootstrap.shift.inOutletGeofence ? 'Inside' : 'Outside'}</Text><Text style={styles.shiftLabel}>Outlet zone</Text></View></View>{trackingMode === 'foreground' && <Text style={styles.dutyHelp}>Expo Go mode: keep the app open for GPS updates. The installed APK tracks with the screen locked.</Text>}</> : <Text style={styles.dutyHelp}>Starting duty enables route tracking. Expo Go tracks while open; the installed APK continues while the screen is locked.</Text>}
            <Pressable disabled={dutyBusy} onPress={bootstrap?.shift ? endDuty : startDuty} style={({pressed}) => [styles.dutyButton, bootstrap?.shift && styles.endDutyButton, (pressed || dutyBusy) && styles.buttonDisabled]}>{dutyBusy ? <ActivityIndicator color={bootstrap?.shift ? '#ef4444' : '#fff'} /> : <Text style={[styles.dutyButtonText, bootstrap?.shift && styles.endDutyText]}>{bootstrap?.shift ? 'End Duty' : 'Start Duty'}</Text>}</Pressable>
          </View>
          <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Current delivery</Text><Text style={styles.sectionCount}>{activeOrders.length}</Text></View>
          {currentOrder ? <DeliveryCard assignment={currentOrder} busy={actionBusy === currentOrder._id} onAction={performAction} onViewDetails={viewOrderDetails} showDialog={showDialog} /> : <View style={styles.emptyCard}><Text style={styles.emptyIcon}>✓</Text><Text style={styles.emptyTitle}>No active delivery</Text><Text style={styles.emptyText}>{bootstrap?.shift ? 'Stay available. A new order will appear here when the cashier assigns it.' : 'Start duty to become available for assignments.'}</Text></View>}
        </>}
        {tab === 'deliveries' && <>
          <View style={styles.sectionHeader}><View><Text style={styles.pageTitle}>My Deliveries</Text><Text style={styles.pageSubtitle}>{businessDate ? `All orders assigned to you for business day ${businessDate}.` : 'All orders assigned to you for the current business day.'}</Text></View></View>
          {activeOrders.map(order => <DeliveryCard key={order._id} assignment={order} busy={actionBusy === order._id} onAction={performAction} onViewDetails={viewOrderDetails} showDialog={showDialog} />)}
          {historyOrders.length > 0 && <><Text style={styles.historyTitle}>BUSINESS DAY HISTORY</Text>{historyOrders.map(order => <DeliveryCard key={order._id} assignment={order} busy={false} onAction={performAction} onViewDetails={viewOrderDetails} showDialog={showDialog} />)}</>}
          {orders.length === 0 && <View style={styles.emptyCard}><Text style={styles.emptyIcon}>□</Text><Text style={styles.emptyTitle}>No deliveries yet</Text><Text style={styles.emptyText}>Orders assigned during this business day will appear here.</Text></View>}
        </>}
        {tab === 'profile' && <>
          <Text style={styles.pageTitle}>Rider Profile</Text><Text style={styles.pageSubtitle}>Account, outlet, device, and location tracking health.</Text>
          <View style={styles.profileCard}><View style={styles.avatar}><Text style={styles.avatarText}>{session.user.name?.charAt(0)?.toUpperCase() || 'R'}</Text></View><Text style={styles.profileName}>{session.user.name}</Text><Text style={styles.profileEmail}>{session.user.email}</Text><View style={styles.profileDivider} />
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Outlet</Text><Text style={styles.profileValue}>{bootstrap?.outlet?.name || session.user.outletCode || '—'}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Tracking service</Text><Text style={[styles.profileValue, trackingActive && styles.goodText]}>{trackingMode === 'background' ? 'Background active' : trackingMode === 'foreground' ? 'Foreground / Expo Go' : 'Stopped'}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Last GPS callback</Text><Text style={styles.profileValue}>{formatTrackingTime(trackingHealth.lastTaskCallbackAt)}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Last server upload</Text><Text style={styles.profileValue}>{formatTrackingTime(trackingHealth.lastUploadAt)}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Queued GPS points</Text><Text style={styles.profileValue}>{trackingHealth.queueDepth}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Battery optimization</Text><Text style={[styles.profileValue, !batteryRestricted && styles.goodText]}>{batteryRestricted ? 'Restricted' : 'Unrestricted'}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Battery Saver</Text><Text style={[styles.profileValue, !lowPowerRestricted && styles.goodText]}>{lowPowerRestricted ? 'On' : 'Off'}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>App version</Text><Text style={styles.profileValue}>{APP_VERSION}</Text></View>
            <View style={styles.profileRow}><Text style={styles.profileLabel}>Server</Text><Text numberOfLines={1} style={[styles.profileValue, styles.serverValue]}>{API_BASE_URL}</Text></View>
          </View>
          {bootstrap?.shift && <Pressable disabled={dutyBusy} onPress={repairTracking} style={styles.repairButton}><Text style={styles.repairButtonText}>{dutyBusy ? 'Repairing Tracking…' : 'Check & Repair Tracking'}</Text></Pressable>}
          <Pressable onPress={openLocationSettings} style={styles.settingsButton}><Text style={styles.settingsButtonText}>Open Android Location Settings</Text></Pressable>
          <Pressable onPress={openBatterySettings} style={styles.settingsButton}><Text style={styles.settingsButtonText}>Open Battery Optimization Settings</Text></Pressable><Text style={styles.settingsHelp}>Set location to “Allow all the time” with precise location, allow notifications, and set Cenciss Delivery battery usage to Unrestricted. Do not force-stop or swipe away the application while on duty.</Text>
          <Pressable onPress={signOut} style={styles.signOutButton}><Text style={styles.signOutText}>Sign Out</Text></Pressable>
        </>}
      </ScrollView>
      <OrderDetailsModal assignment={selectedOrder} loading={detailsLoading} onClose={() => setSelectedOrder(null)} showDialog={showDialog} />
      <AppDialogModal dialog={dialog} onClose={closeDialog} />
      <View style={[styles.tabBar, {paddingBottom: Math.max(insets.bottom, 8)}]}>{([['home', '⌂', 'Home'], ['deliveries', '↗', 'Deliveries'], ['profile', '●', 'Profile']] as const).map(([value, icon, label]) => <Pressable key={value} onPress={() => selectTab(value)} style={styles.tabButton}><Text style={[styles.tabIcon, tab === value && styles.tabActive]}>{icon}</Text><Text style={[styles.tabLabel, tab === value && styles.tabActive]}>{label}</Text>{tab === value && <View style={styles.tabIndicator} />}</Pressable>)}</View>
    </View>
  );
};

const App = () => <SafeAreaProvider><RiderApp /></SafeAreaProvider>;

const styles = StyleSheet.create({
  appShell: {flex: 1, backgroundColor: '#f8fafc'}, loadingPage: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc', gap: 14}, loadingText: {color: '#64748b', fontWeight: '600'},
  header: {backgroundColor: '#fff', paddingHorizontal: 18, paddingBottom: 13, borderBottomWidth: 1, borderBottomColor: '#e2e8f0', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, headerBrand: {fontSize: 10, fontWeight: '900', color: '#6366f1', letterSpacing: 1.8}, headerOutlet: {fontSize: 17, fontWeight: '900', color: '#0f172a', marginTop: 2}, content: {flex: 1}, contentContainer: {padding: 16, paddingBottom: 120},
  loginPage: {flexGrow: 1, paddingHorizontal: 22, backgroundColor: '#f8fafc', alignItems: 'center'}, logoMark: {width: 76, height: 76, borderRadius: 24, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', shadowColor: '#2f66e8', shadowOpacity: 0.24, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8}, loginLogo: {width: 58, height: 61}, brand: {marginTop: 20, fontSize: 11, fontWeight: '900', color: '#2f66e8', letterSpacing: 3}, loginTitle: {fontSize: 32, fontWeight: '900', color: '#0f172a', marginTop: 3}, loginSubtitle: {fontSize: 14, lineHeight: 21, color: '#64748b', textAlign: 'center', marginTop: 8, maxWidth: 320},
  loginCard: {width: '100%', backgroundColor: '#fff', borderRadius: 24, padding: 20, marginTop: 30, borderWidth: 1, borderColor: '#e2e8f0', shadowColor: '#0f172a', shadowOpacity: 0.06, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 3}, inputLabel: {fontSize: 10, fontWeight: '900', color: '#64748b', letterSpacing: 1.2, marginBottom: 7, marginTop: 11}, input: {borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#f8fafc', borderRadius: 13, paddingHorizontal: 14, height: 49, color: '#0f172a', fontSize: 15}, primaryButton: {height: 52, borderRadius: 14, backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', marginTop: 22}, primaryButtonText: {color: '#fff', fontSize: 15, fontWeight: '900'}, loginFootnote: {fontSize: 12, color: '#94a3b8', textAlign: 'center', marginTop: 22, maxWidth: 300},
  badge: {backgroundColor: '#f1f5f9', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5}, badgeGood: {backgroundColor: '#dcfce7'}, badgeWarn: {backgroundColor: '#fef3c7'}, badgeInfo: {backgroundColor: '#e0e7ff'}, badgeText: {fontSize: 10, fontWeight: '900', color: '#64748b', textTransform: 'uppercase'}, badgeTextGood: {color: '#15803d'}, badgeTextWarn: {color: '#b45309'}, badgeTextInfo: {color: '#4338ca'},
  dialogOverlay: {flex: 1, backgroundColor: 'rgba(15,23,42,0.58)', alignItems: 'center', justifyContent: 'center', padding: 22}, dialogCard: {width: '100%', maxWidth: 420, borderRadius: 24, backgroundColor: '#fff', padding: 22, shadowColor: '#0f172a', shadowOpacity: 0.25, shadowRadius: 24, shadowOffset: {width: 0, height: 12}, elevation: 16}, dialogIcon: {width: 48, height: 48, borderRadius: 16, backgroundColor: '#eef2ff', alignItems: 'center', justifyContent: 'center'}, dialogIconDanger: {backgroundColor: '#fef2f2'}, dialogTitle: {fontSize: 21, fontWeight: '900', color: '#0f172a', marginTop: 16}, dialogMessage: {fontSize: 14, lineHeight: 21, color: '#64748b', marginTop: 7}, dialogActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 9, marginTop: 22}, dialogSecondaryButton: {minHeight: 45, borderRadius: 13, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff', paddingHorizontal: 17, alignItems: 'center', justifyContent: 'center'}, dialogSecondaryText: {fontSize: 13, fontWeight: '900', color: '#475569'}, dialogPrimaryButton: {minHeight: 45, borderRadius: 13, backgroundColor: '#4f46e5', paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center'}, dialogPrimaryDanger: {backgroundColor: '#dc2626'}, dialogPrimaryText: {fontSize: 13, fontWeight: '900', color: '#fff'},
  dutyCard: {backgroundColor: '#0f172a', borderRadius: 24, padding: 20, marginBottom: 22, shadowColor: '#0f172a', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 5}, dutyCardActive: {backgroundColor: '#064e3b'}, rowBetween: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12}, flexOne: {flex: 1}, eyebrow: {fontSize: 10, fontWeight: '900', color: '#818cf8', letterSpacing: 1.5}, eyebrowActive: {color: '#6ee7b7'}, dutyTitle: {fontSize: 23, fontWeight: '900', color: '#fff', marginTop: 4}, dutyTitleActive: {color: '#ecfdf5'}, trackingDot: {width: 13, height: 13, borderRadius: 99, backgroundColor: '#475569', marginTop: 4}, trackingDotActive: {backgroundColor: '#34d399', borderWidth: 3, borderColor: '#065f46'}, dutyHelp: {fontSize: 13, color: '#cbd5e1', lineHeight: 19, marginTop: 14}, dutyButton: {height: 49, borderRadius: 14, backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', marginTop: 18}, endDutyButton: {backgroundColor: '#fff'}, dutyButtonText: {color: '#fff', fontWeight: '900', fontSize: 14}, endDutyText: {color: '#dc2626'}, shiftStats: {flexDirection: 'row', justifyContent: 'space-between', marginTop: 20, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 16, padding: 14}, shiftValue: {color: '#fff', fontSize: 16, fontWeight: '900'}, shiftLabel: {color: '#a7f3d0', fontSize: 10, marginTop: 2},
  sectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12}, sectionTitle: {fontSize: 19, fontWeight: '900', color: '#0f172a'}, sectionCount: {backgroundColor: '#e0e7ff', color: '#4338ca', minWidth: 26, textAlign: 'center', borderRadius: 99, paddingVertical: 4, fontSize: 12, fontWeight: '900'}, pageTitle: {fontSize: 26, fontWeight: '900', color: '#0f172a'}, pageSubtitle: {fontSize: 13, color: '#64748b', lineHeight: 19, marginTop: 4, marginBottom: 16},
  deliveryCard: {backgroundColor: '#fff', borderRadius: 22, borderWidth: 1, borderColor: '#e2e8f0', padding: 18, marginBottom: 14, shadowColor: '#0f172a', shadowOpacity: 0.05, shadowRadius: 12, shadowOffset: {width: 0, height: 5}, elevation: 2}, orderNumber: {fontSize: 22, fontWeight: '900', color: '#0f172a', marginTop: 2}, divider: {height: 1, backgroundColor: '#f1f5f9', marginVertical: 14}, customerName: {fontSize: 16, fontWeight: '800', color: '#1e293b'}, customerPhoneRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 7}, customerPhone: {color: '#475569', fontSize: 13, fontWeight: '700'}, contactActions: {flexDirection: 'row', gap: 9, marginTop: 10}, callButton: {flex: 1, height: 40, borderRadius: 11, backgroundColor: '#eef2ff', alignItems: 'center', justifyContent: 'center'}, callButtonText: {color: '#4338ca', fontWeight: '900', fontSize: 13}, whatsappButton: {flex: 1, height: 40, borderRadius: 11, backgroundColor: '#dcfce7', alignItems: 'center', justifyContent: 'center'}, whatsappButtonText: {color: '#15803d', fontWeight: '900', fontSize: 13}, address: {fontSize: 13, color: '#475569', lineHeight: 19, marginTop: 9}, orderItemsBox: {backgroundColor: '#f8fafc', borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10, marginTop: 13, borderWidth: 1, borderColor: '#e2e8f0'}, orderItemsHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 5}, orderItemsTitle: {fontSize: 9, color: '#64748b', fontWeight: '900', letterSpacing: 1}, orderItemsCount: {fontSize: 10, color: '#4338ca', fontWeight: '900', backgroundColor: '#e0e7ff', borderRadius: 99, minWidth: 21, paddingVertical: 2, textAlign: 'center'}, orderItemRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, paddingVertical: 8}, orderItemDivider: {borderTopWidth: 1, borderTopColor: '#e2e8f0'}, orderItemMain: {flex: 1}, orderItemName: {fontSize: 13, color: '#1e293b', fontWeight: '800'}, orderItemVariation: {fontSize: 11, color: '#6366f1', fontWeight: '700', marginTop: 2}, orderItemNote: {fontSize: 11, color: '#92400e', marginTop: 3}, orderItemAmount: {fontSize: 12, color: '#475569', fontWeight: '700'}, orderMeta: {flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 13}, metaText: {fontSize: 11, color: '#64748b', fontWeight: '600', flexShrink: 1}, noteBox: {backgroundColor: '#fffbeb', borderRadius: 12, padding: 11, marginTop: 12}, noteLabel: {fontSize: 9, color: '#b45309', fontWeight: '900', letterSpacing: 1}, noteText: {fontSize: 12, lineHeight: 18, color: '#78350f', marginTop: 3}, detailsButton: {height: 43, borderRadius: 12, backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', marginTop: 14}, detailsButtonText: {color: '#fff', fontWeight: '900', fontSize: 13}, mapButton: {height: 43, borderRadius: 12, backgroundColor: '#eef2ff', alignItems: 'center', justifyContent: 'center', marginTop: 10}, mapButtonText: {color: '#4338ca', fontWeight: '800', fontSize: 13}, actions: {flexDirection: 'row', gap: 9, marginTop: 10}, actionButton: {flex: 1, minHeight: 48, borderRadius: 13, backgroundColor: '#4f46e5', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8}, actionDanger: {backgroundColor: '#dc2626'}, actionSuccess: {backgroundColor: '#059669'}, actionText: {color: '#fff', fontWeight: '900', textAlign: 'center', fontSize: 13}, buttonDisabled: {opacity: 0.56},
  detailsPage: {flex: 1, backgroundColor: '#f8fafc', paddingHorizontal: 16}, detailsTopBar: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: '#e2e8f0'}, detailsOrderNumber: {fontSize: 25, fontWeight: '900', color: '#0f172a', marginTop: 2}, detailsCloseIcon: {width: 38, height: 38, borderRadius: 12, backgroundColor: '#e2e8f0', alignItems: 'center', justifyContent: 'center'}, detailsCloseIconText: {fontSize: 27, lineHeight: 29, color: '#475569', fontWeight: '500'}, detailsLoading: {flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: '#eef2ff', borderRadius: 12, padding: 10, marginTop: 12}, detailsLoadingText: {fontSize: 12, color: '#4338ca', fontWeight: '700'}, detailsScroll: {flex: 1}, detailsContent: {paddingVertical: 14, gap: 12}, detailsSection: {backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: '#e2e8f0', padding: 14}, detailsSectionTitle: {fontSize: 9, color: '#64748b', fontWeight: '900', letterSpacing: 1.1, marginBottom: 8}, detailsCustomer: {fontSize: 17, color: '#1e293b', fontWeight: '900'}, detailsMissing: {fontSize: 12, color: '#94a3b8', fontStyle: 'italic', lineHeight: 18}, detailsAddress: {fontSize: 14, color: '#334155', lineHeight: 21, fontWeight: '600'}, detailsItemRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, paddingVertical: 10}, detailsTotal: {backgroundColor: '#0f172a', borderRadius: 16, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}, detailsTotalLabel: {fontSize: 13, color: '#cbd5e1', fontWeight: '700'}, detailsTotalValue: {fontSize: 20, color: '#fff', fontWeight: '900'}, detailsCloseButton: {height: 49, borderRadius: 14, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', marginTop: 10}, detailsCloseButtonText: {color: '#fff', fontSize: 14, fontWeight: '900'},
  emptyCard: {backgroundColor: '#fff', borderRadius: 22, borderWidth: 1, borderColor: '#e2e8f0', borderStyle: 'dashed', alignItems: 'center', padding: 28}, emptyIcon: {fontSize: 28, color: '#94a3b8'}, emptyTitle: {fontSize: 16, fontWeight: '900', color: '#334155', marginTop: 8}, emptyText: {fontSize: 13, lineHeight: 19, textAlign: 'center', color: '#64748b', marginTop: 5}, offlineBanner: {backgroundColor: '#fef3c7', borderRadius: 15, padding: 13, marginBottom: 14, borderWidth: 1, borderColor: '#fde68a'}, offlineTitle: {fontSize: 13, fontWeight: '900', color: '#92400e'}, offlineText: {fontSize: 11, color: '#a16207', marginTop: 2}, trackingWarning: {backgroundColor: '#fff7ed', borderRadius: 16, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: '#fed7aa'}, trackingWarningTitle: {fontSize: 14, fontWeight: '900', color: '#9a3412'}, trackingWarningText: {fontSize: 12, lineHeight: 18, color: '#c2410c', marginTop: 3}, trackingRepairButton: {alignSelf: 'flex-start', backgroundColor: '#ea580c', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 9, marginTop: 10}, trackingRepairText: {fontSize: 12, fontWeight: '900', color: '#fff'}, historyTitle: {fontSize: 10, fontWeight: '900', color: '#94a3b8', letterSpacing: 1.5, marginVertical: 16},
  profileCard: {backgroundColor: '#fff', borderRadius: 22, borderWidth: 1, borderColor: '#e2e8f0', padding: 18, alignItems: 'center'}, avatar: {width: 64, height: 64, borderRadius: 22, backgroundColor: '#e0e7ff', alignItems: 'center', justifyContent: 'center'}, avatarText: {fontSize: 25, fontWeight: '900', color: '#4338ca'}, profileName: {fontSize: 20, fontWeight: '900', color: '#0f172a', marginTop: 12}, profileEmail: {fontSize: 13, color: '#64748b', marginTop: 3}, profileDivider: {height: 1, backgroundColor: '#f1f5f9', width: '100%', marginVertical: 18}, profileRow: {width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, gap: 12}, profileLabel: {fontSize: 13, color: '#64748b'}, profileValue: {fontSize: 13, fontWeight: '800', color: '#334155', textAlign: 'right'}, serverValue: {maxWidth: '62%'}, goodText: {color: '#059669'}, repairButton: {height: 48, borderRadius: 14, backgroundColor: '#059669', alignItems: 'center', justifyContent: 'center', marginTop: 14}, repairButtonText: {color: '#fff', fontWeight: '900'}, settingsButton: {height: 48, borderRadius: 14, backgroundColor: '#eef2ff', alignItems: 'center', justifyContent: 'center', marginTop: 12}, settingsButtonText: {color: '#4338ca', fontWeight: '900'}, settingsHelp: {fontSize: 12, lineHeight: 18, color: '#64748b', marginTop: 10, paddingHorizontal: 5}, signOutButton: {height: 49, borderRadius: 14, borderWidth: 1, borderColor: '#fecaca', backgroundColor: '#fef2f2', alignItems: 'center', justifyContent: 'center', marginTop: 22}, signOutText: {color: '#dc2626', fontWeight: '900'},
  tabBar: {position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e2e8f0', paddingTop: 8, shadowColor: '#0f172a', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: {width: 0, height: -4}, elevation: 12}, tabButton: {flex: 1, alignItems: 'center', paddingVertical: 5, position: 'relative'}, tabIcon: {fontSize: 17, color: '#94a3b8', fontWeight: '900'}, tabLabel: {fontSize: 10, color: '#94a3b8', fontWeight: '800', marginTop: 2}, tabActive: {color: '#4f46e5'}, tabIndicator: {position: 'absolute', top: -8, width: 28, height: 3, borderRadius: 99, backgroundColor: '#4f46e5'},
});

export default App;

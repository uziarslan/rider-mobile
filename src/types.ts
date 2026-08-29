export type GeoLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  altitude?: number;
  isMock?: boolean;
  recordedAtEpoch?: number;
};

export type RiderLocationPoint = GeoLocation & {
  clientPointId: string;
  batteryLevel?: number;
  source: 'gps' | 'network' | 'passive';
  recordedAt: string;
};

export type RiderUser = {
  id?: string;
  _id?: string;
  name: string;
  email: string;
  role: 'rider';
  outlet?: string;
  outletCode?: string;
  outletRef?: string;
};

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  apiBaseUrl: string;
  user: RiderUser;
};

export type DeliveryStatus = 'assigned' | 'accepted' | 'picked_up' | 'delivered' | 'delivery_failed' | 'returned_to_restaurant' | 'reassigned' | 'cancelled';

export type DeliveryItem = {
  menuItem?: string | null;
  name: string;
  variation?: {
    id?: string | null;
    name?: string;
  };
  qty: number;
  unitPrice?: number;
  lineTotal?: number;
  notes?: string;
};

export type DeliveryAssignment = {
  _id: string;
  active: boolean;
  orderNumber: string;
  status: DeliveryStatus;
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: {
    label?: string;
    street?: string;
    area?: string;
    city?: string;
    latitude?: number | null;
    longitude?: number | null;
  };
  totalAmount?: number;
  notes?: string;
  items?: DeliveryItem[];
  assignedAt?: string;
};

export type RiderBootstrap = {
  rider: RiderUser;
  outlet: {
    _id: string;
    name: string;
    code: string;
    address?: string;
    tracking?: Record<string, unknown>;
  };
  shift: null | {
    _id: string;
    startedAt: string;
    pointCount?: number;
    distanceMeters?: number;
    inOutletGeofence?: boolean | null;
  };
  assignments: DeliveryAssignment[];
  trackingRequired: boolean;
  serverTime: string;
};

export type PendingAction = {
  id: string;
  assignmentId: string;
  action: 'accept' | 'picked_up' | 'delivered' | 'delivery_failed' | 'returned_to_restaurant';
  clientEventId: string;
  location?: GeoLocation;
  queuedAt: string;
};

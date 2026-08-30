import type {DeliveryAssignment, DeliveryRun} from './types';

export type AssignmentSocketPayload = Partial<DeliveryAssignment> & {
  assignmentId?: string;
};

export const applyAssignmentSocketEvent = (
  assignments: DeliveryAssignment[],
  payload?: AssignmentSocketPayload,
): DeliveryAssignment[] => {
  const id = String(payload?._id || payload?.assignmentId || '').trim();
  if (!id || !payload) return assignments;
  const index = assignments.findIndex(assignment => assignment._id === id);
  if (index < 0) {
    if (!payload.orderNumber || !payload.status) return assignments;
    return [{...payload, _id: id} as DeliveryAssignment, ...assignments];
  }
  const merged = {...assignments[index], ...payload, _id: id};
  if (JSON.stringify(assignments[index]) === JSON.stringify(merged)) return assignments;
  const next = [...assignments];
  next[index] = merged;
  return next;
};

export const applyAssignmentSocketEvents = (
  assignments: DeliveryAssignment[],
  payloads: AssignmentSocketPayload[] = [],
): DeliveryAssignment[] => payloads.reduce(applyAssignmentSocketEvent, assignments);

export const replaceAssignmentsIfChanged = (
  current: DeliveryAssignment[],
  next: DeliveryAssignment[],
): DeliveryAssignment[] => JSON.stringify(current) === JSON.stringify(next) ? current : next;

const stopCompleted = (assignment: DeliveryAssignment) => (
  assignment.status === 'delivered' || assignment.status === 'delivery_failed'
);

export const deliveryRunsFromAssignments = (
  assignments: DeliveryAssignment[],
): DeliveryRun[] => {
  const groups = new Map<string, DeliveryAssignment[]>();
  for (const assignment of assignments) {
    const id = assignment.deliveryRunId || `legacy-${assignment._id}`;
    const rows = groups.get(id) || [];
    rows.push(assignment);
    groups.set(id, rows);
  }
  return [...groups.entries()].map(([id, rows]) => {
    const orders = [...rows].sort((a, b) => (
      Number(a.routeSequence || Number.MAX_SAFE_INTEGER) - Number(b.routeSequence || Number.MAX_SAFE_INTEGER)
      || new Date(a.assignedAt || 0).getTime() - new Date(b.assignedAt || 0).getTime()
    ));
    const completedStops = orders.filter(stopCompleted).length;
    return {
      id,
      orders,
      completedStops,
      totalStops: orders.length,
      canReturn: orders.length > 0 && completedStops === orders.length,
      waitingForPickup: orders.every((order) => order.pickupState === 'queued_at_restaurant'),
    };
  });
};

export const assignmentAddressText = (assignment: DeliveryAssignment): string => {
  const address = assignment.deliveryAddress || {};
  return [address.label, address.street, address.area, address.city]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(', ');
};

export const assignmentMapsQuery = (assignment: DeliveryAssignment): string => {
  const {latitude, longitude} = assignment.deliveryAddress || {};
  const hasLatitude = latitude !== null && latitude !== undefined && String(latitude).trim() !== '';
  const hasLongitude = longitude !== null && longitude !== undefined && String(longitude).trim() !== '';
  if (hasLatitude && hasLongitude && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))) {
    return `${Number(latitude)},${Number(longitude)}`;
  }
  return assignmentAddressText(assignment);
};

export const whatsappPhoneNumber = (phone?: string): string => {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Restaurant phone numbers are Pakistani; WhatsApp requires the country code
  // and no leading local zero (0300… becomes 92300…).
  if (digits.startsWith('0')) digits = `92${digits.slice(1)}`;
  return digits;
};

export const assignmentWhatsAppUrl = (assignment: DeliveryAssignment): string => {
  const phone = whatsappPhoneNumber(assignment.customerPhone);
  if (!phone) return '';
  const greeting = assignment.customerName ? `Hello ${assignment.customerName},` : 'Hello,';
  const message = `${greeting} I am your rider for order ${assignment.orderNumber}. I am contacting you regarding your delivery.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
};

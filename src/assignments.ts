import type {DeliveryAssignment} from './types';

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
  const next = [...assignments];
  next[index] = {...assignments[index], ...payload, _id: id};
  return next;
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

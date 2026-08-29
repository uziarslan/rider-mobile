import {
  applyAssignmentSocketEvent,
  assignmentMapsQuery,
  assignmentWhatsAppUrl,
  whatsappPhoneNumber,
} from '../src/assignments';
import type {DeliveryAssignment} from '../src/types';

const accepted: DeliveryAssignment = {
  _id: 'assignment-1',
  active: true,
  orderNumber: 'ORD-1001',
  status: 'accepted',
  customerName: '',
  customerPhone: '',
  deliveryAddress: {},
  items: [],
};

test('merges customer, address, total, and items delivered over Socket.IO after acceptance', () => {
  const result = applyAssignmentSocketEvent([accepted], {
    _id: 'assignment-1',
    customerName: 'Ayesha Khan',
    customerPhone: '03001234567',
    deliveryAddress: {street: '12 Main Road', area: 'Gulberg', city: 'Lahore'},
    totalAmount: 1450,
    items: [{name: 'Zinger Burger', qty: 2, unitPrice: 650, lineTotal: 1300, variation: {name: 'Large'}}],
  });

  expect(result[0]).toMatchObject({
    status: 'accepted',
    customerName: 'Ayesha Khan',
    customerPhone: '03001234567',
    totalAmount: 1450,
  });
  expect(result[0].deliveryAddress?.area).toBe('Gulberg');
  expect(result[0].items?.[0]).toMatchObject({name: 'Zinger Burger', qty: 2});
});

test('adds a complete new assignment received over Socket.IO', () => {
  const result = applyAssignmentSocketEvent([], {
    _id: 'assignment-2',
    active: true,
    orderNumber: 'ORD-1002',
    status: 'assigned',
    items: [{name: 'Fries', qty: 1, unitPrice: 250, lineTotal: 250}],
  });

  expect(result).toHaveLength(1);
  expect(result[0].items?.[0].name).toBe('Fries');
});

test('uses the cashier address when stored coordinates are null', () => {
  expect(assignmentMapsQuery({
    ...accepted,
    deliveryAddress: {
      street: '12 Main Road', area: 'Gulberg', city: 'Lahore',
      latitude: null, longitude: null,
    },
  })).toBe('12 Main Road, Gulberg, Lahore');
});

test('uses valid coordinates without ever formatting null,null', () => {
  expect(assignmentMapsQuery({
    ...accepted,
    deliveryAddress: {street: 'Fallback address', latitude: 31.5204, longitude: 74.3587},
  })).toBe('31.5204,74.3587');
  expect(assignmentMapsQuery({...accepted, deliveryAddress: {latitude: null, longitude: null}})).toBe('');
});

test('opens a Pakistani local phone number as an international WhatsApp chat', () => {
  expect(whatsappPhoneNumber('0300-1234567')).toBe('923001234567');
  expect(whatsappPhoneNumber('+92 300 1234567')).toBe('923001234567');
  const url = assignmentWhatsAppUrl({...accepted, customerName: 'Ayesha', customerPhone: '03001234567'});
  expect(url).toContain('https://wa.me/923001234567?text=');
  expect(decodeURIComponent(url)).toContain('order ORD-1001');
});

'use strict';

const { FrameoWidget } = require('../../lib/frameo-widget');

async function invoke(homey, operation, deviceId) {
  try {
    if (typeof homey?.app?.widget?.[operation] !== 'function') return { error: { code: 'ENGINE_NOT_READY' } };
    return await homey.app.widget[operation]({ deviceId });
  } catch (error) {
    // Use a JSON envelope because Homey API transports do not consistently
    // preserve custom Error properties. Never forward an upstream message.
    return { error: { code: FrameoWidget.errorCode(error?.code) } };
  }
}

module.exports = {
  async getPhoto({ homey, query }) {
    return invoke(homey, 'state', query?.deviceId);
  },
  async nextPhoto({ homey, body }) {
    return invoke(homey, 'next', body?.deviceId);
  },
};

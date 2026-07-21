export interface ClientAccessProbe {
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
}

const IPHONE_DEVICE = /^Mozilla\/5\.0 \(iPhone;/;
const IPHONE_IOS_15_VERSION = /\bCPU iPhone OS 15(?:[_.]\d+){0,2}\b/i;
const FIREFOX_VERSION = /\bFirefox\/\d+(?:\.\d+)*\b/;

export function isIphoneIos15UserAgent(userAgent: string): boolean {
  return (
    IPHONE_DEVICE.test(userAgent) &&
    userAgent.includes('AppleWebKit/') &&
    userAgent.includes('(KHTML, like Gecko)') &&
    IPHONE_IOS_15_VERSION.test(userAgent)
  );
}

export function isLinuxFirefoxUserAgent(userAgent: string): boolean {
  return (
    userAgent.startsWith('Mozilla/5.0 (') &&
    userAgent.includes('Linux') &&
    !userAgent.includes('Android') &&
    userAgent.includes('Gecko/20100101') &&
    FIREFOX_VERSION.test(userAgent)
  );
}

export function isClientAllowed({ userAgent, screenWidth, screenHeight }: ClientAccessProbe): boolean {
  return (
    isIphoneIos15UserAgent(userAgent) ||
    (isLinuxFirefoxUserAgent(userAgent) && screenWidth === 1200 && screenHeight === 1920)
  );
}

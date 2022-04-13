import { regEx } from '../../../util/regex';
import { joinUrlParts } from '../../../util/url';

export const defaultRegistryUrl = 'https://git.code.tencent.com';

export function getDepHost(registryUrl: string = defaultRegistryUrl): string {
  return registryUrl.replace(regEx(/\/api\/v3$/), '');
}

export function tgitSourceUrl(
  packageName: string,
  registryUrl?: string
): string {
  const depHost = getDepHost(registryUrl);
  return joinUrlParts(depHost, packageName);
}

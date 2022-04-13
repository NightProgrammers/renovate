import { getDepHost, tgitSourceUrl } from './util';

describe('modules/datasource/tgit-tags/util', () => {
  describe('getDepHost', () => {
    it('works', () => {
      expect(getDepHost()).toBe('https://git.code.tencent.com');
      expect(getDepHost('https://tgit.domain.test/api/v3')).toBe(
        'https://tgit.domain.test'
      );
      expect(getDepHost('https://domain.test/tgit/api/v3')).toBe(
        'https://domain.test/tgit'
      );
    });
  });

  describe('getSourceUrl', () => {
    it('works', () => {
      expect(tgitSourceUrl('some/repo')).toBe(
        'https://git.code.tencent.com/some/repo'
      );
      expect(
        tgitSourceUrl('some/repo', 'https://tgit.domain.test/api/v3')
      ).toBe('https://tgit.domain.test/some/repo');
    });
  });
});

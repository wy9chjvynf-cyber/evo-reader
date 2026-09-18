import { describe, expect, it } from 'vitest';
import { DEFAULT_UI, normalizeUI } from '../uiPreferences';
describe('UI recovery', () => {
  it('recovers missing and malformed state without changing book storage', () => {
    for (const value of [undefined, null, 'broken', {view:'deleted-route', theme:'invalid', fontSize:NaN}]) expect(normalizeUI(value)).toEqual(DEFAULT_UI);
  });
  it('clamps unsupported font sizes and keeps known preferences', () => {
    expect(normalizeUI({view:'reader', theme:'oled', fontSize:900})).toEqual({version:1,view:'reader',theme:'oled',fontSize:32});
    expect(normalizeUI({fontSize:-1}).fontSize).toBe(18);
  });
});

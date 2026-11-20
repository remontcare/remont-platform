import { Language } from '@prisma/client';
import { detectLanguage, hasNoHindiSignal } from './intent-engine';

describe('REMI language detection', () => {
  it('treats short Hinglish replies as Hinglish (they were classed as English, so REMI answered in English)', () => {
    for (const m of ['Haan, AC service cart me add kar do', 'Haan theek hai', 'AC thanda nahi kar raha', 'Plumber chahiye kal', 'Kitna lagega batao', 'Mera naam Rahul hai']) {
      expect(hasNoHindiSignal(m)).toBe(false);
    }
  });

  it('keeps plain English as English', () => {
    for (const m of ['My AC is not cooling', 'Please add it to my cart', 'Book a plumber for tomorrow', 'What does it cost?', 'Send me the details', 'Do it today']) {
      expect(hasNoHindiSignal(m)).toBe(true);
      expect(detectLanguage(m)).toBe(Language.EN);
    }
  });

  it('detects Devanagari Hindi', () => {
    expect(detectLanguage('मेरा एसी ठंडा नहीं कर रहा')).toBe(Language.HI);
    expect(hasNoHindiSignal('मेरा एसी ठंडा नहीं कर रहा')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { ESSAY_SITES_DEFAULT, effectiveMode, hostMatches } from '../../src/core/modes';

describe('hostMatches', () => {
  it('matches exact and subdomains, case-insensitively', () => {
    expect(hostMatches('commonapp.org', 'commonapp.org')).toBe(true);
    expect(hostMatches('apply.commonapp.org', 'commonapp.org')).toBe(true);
    expect(hostMatches('Apply.CommonApp.org', 'commonapp.ORG')).toBe(true);
  });
  it('does not match a host that merely ends with the domain text', () => {
    expect(hostMatches('notcommonapp.org', 'commonapp.org')).toBe(false);
  });
});

describe('effectiveMode', () => {
  it('apply.commonapp.org is essay', () => {
    expect(effectiveMode('apply.commonapp.org', {}, ESSAY_SITES_DEFAULT)).toBe('essay');
  });
  it('mail.google.com is standard', () => {
    expect(effectiveMode('mail.google.com', {}, ESSAY_SITES_DEFAULT)).toBe('standard');
  });
  it('discord.com is casual', () => {
    expect(effectiveMode('discord.com', {}, ESSAY_SITES_DEFAULT)).toBe('casual');
  });
  it('example.com is standard', () => {
    expect(effectiveMode('example.com', {}, ESSAY_SITES_DEFAULT)).toBe('standard');
  });
  it('siteModes override wins', () => {
    expect(effectiveMode('discord.com', { 'discord.com': 'essay' }, ESSAY_SITES_DEFAULT)).toBe('essay');
    expect(effectiveMode('commonapp.org', { 'commonapp.org': 'casual' }, ESSAY_SITES_DEFAULT)).toBe('casual');
  });
});

import { ESSAY_FAMILY_DEFAULTS, defaultFamilies, migrateFamilies, migrateStandardEngagement } from '../../src/core/modes';

const ALL_OFF = { clarity: false, engagement: false, delivery: false, generic: false };
// Defaults: a toggle under 0.9 precision with the defaults is off: generic in Essay and delivery in Standard (lc-5
// rounds). Clarity is on in both modes by choice, though a run measured it just under 0.9 (0.895 Essay, 0.875
// Standard); engagement is on in Standard by choice (0.88 at lc-6), for its word-choice suggestions; generic is off in
// Standard by choice.
const STANDARD = { clarity: true, engagement: true, delivery: false, generic: false };
const ESSAY = { clarity: true, engagement: true, delivery: true, generic: false };

describe('defaultFamilies', () => {
  it('casual all off; standard and essay per the eval measurements', () => {
    expect(defaultFamilies('casual')).toEqual(ALL_OFF);
    expect(defaultFamilies('standard')).toEqual(STANDARD);
    expect(defaultFamilies('essay')).toEqual(ESSAY_FAMILY_DEFAULTS);
    expect(ESSAY_FAMILY_DEFAULTS).toEqual(ESSAY);
  });
  it('returns a copy', () => {
    defaultFamilies('essay').engagement = false;
    expect(defaultFamilies('essay').engagement).toBe(ESSAY_FAMILY_DEFAULTS.engagement);
    expect(ESSAY_FAMILY_DEFAULTS.engagement).toBe(true);
  });
});

describe('migrateFamilies', () => {
  it('null gives the defaults', () => {
    expect(migrateFamilies(null)).toEqual({
      essay: ESSAY,
      standard: STANDARD,
      casual: ALL_OFF,
    });
  });
  it('clarity off everywhere keeps the others at their defaults', () => {
    const m = migrateFamilies({ essay: false, standard: false, casual: false });
    expect(m.essay).toEqual({ ...ESSAY, clarity: false });
    expect(m.standard).toEqual({ ...STANDARD, clarity: false });
    expect(m.casual).toEqual(ALL_OFF);
  });
  it('clarity is taken per mode', () => {
    const m = migrateFamilies({ essay: true, standard: false, casual: false });
    expect(m.essay.clarity).toBe(true);
    expect(m.standard.clarity).toBe(false);
  });
  it('casual stays off even if the old clarity value was on', () => {
    expect(migrateFamilies({ essay: true, standard: true, casual: true }).casual).toEqual(ALL_OFF);
  });
});

describe('migrateStandardEngagement', () => {
  const stored = (essay: boolean, standard: boolean) => ({
    essay: { ...ESSAY, engagement: essay },
    standard: { clarity: false, engagement: standard, delivery: true, generic: false },
    casual: ALL_OFF,
  });

  it('Essay on with Standard off (the old default, which the switches never write) turns Standard on', () => {
    expect(migrateStandardEngagement(stored(true, false))).toEqual(stored(true, true));
  });
  it('a writer who turned Engagement off (off in both) keeps it off', () => {
    expect(migrateStandardEngagement(stored(false, false))).toEqual(stored(false, false));
  });
  it('leaves every other combination and every other toggle as stored', () => {
    expect(migrateStandardEngagement(stored(true, true))).toEqual(stored(true, true));
    expect(migrateStandardEngagement(stored(false, true))).toEqual(stored(false, true));
  });
  it('does not change the value it is given', () => {
    const old = stored(true, false);
    migrateStandardEngagement(old);
    expect(old).toEqual(stored(true, false));
  });
  it('a value missing a mode is returned as is', () => {
    const partial = { essay: ESSAY } as unknown as Parameters<typeof migrateStandardEngagement>[0];
    expect(migrateStandardEngagement(partial)).toEqual({ essay: ESSAY });
  });
});

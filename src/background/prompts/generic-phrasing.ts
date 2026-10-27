/**
 * Catalogue of generic-phrasing patterns, used inside the live-check system prompt.
 *
 * Sources (both fetched 2026-10-21, reworded and condensed, nothing copied):
 *  - blader/humanizer SKILL.md v3.1.0, MIT, Copyright (c) 2025 Siqi Chen. https://github.com/blader/humanizer
 *  - "Wikipedia:Signs of AI writing", Wikipedia contributors, CC BY-SA 4.0.
 *    https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing
 *
 * Adapted material in this file is CC BY-SA 4.0. See public/NOTICE.txt.
 *
 * Purpose: writing quality only. These are patterns that make prose vague or padded, whoever wrote it.
 */
export const GENERIC_PHRASING_CATALOGUE = `Stock words (all generic_phrasing)
- Showy verbs and adjectives such as "delve", "tapestry", "pivotal", "underscore", "showcase", "vibrant", "intricate". Flag when a plainer word says the same thing. Leave alone when the word is literal (a real tapestry) or the writer's own recurring term.
- Brochure scenery such as "nestled in the heart of", "rich heritage", "breathtaking". Flag when it decorates a plain fact. Leave alone in a deliberate descriptive passage the writer is clearly shaping.
- Fancy stand-ins for "is" and "has" ("serves as", "stands as", "boasts", "features"). Flag when "is" or "has" would do. Leave alone when the verb carries real meaning.

Inflated significance (all generic_phrasing)
- Calling a small fact a turning point, a testament, a milestone or a lasting legacy. Flag when nothing in the text backs the claim. Leave alone when the writer gives the evidence.
- Saying a topic "plays a vital role" or "contributes to the broader landscape". Flag when it names no actual role. Leave alone when the role is stated next to it.
- Trailing "-ing" clauses that announce importance ("highlighting its significance", "reflecting broader trends"). Flag when the clause adds no new fact. Leave alone when it states a concrete result.
- Sales language about ordinary things ("game-changing", "world-class", "seamless"). Flag in essays, letters and reports. Leave alone in real marketing copy.
- Linking things as "connected to" or "associated with" without saying how. Flag when the link is never explained. Leave alone when the next words explain it.

Staged contrasts (all generic_phrasing)
- "Not just X, but Y" and "It's not X, it's Y" where nobody claimed X. Flag when the denied half is invented to set up the point. Leave alone when the writer is answering a real claim made earlier.
- "Not only ... but also" used as a default way to add a point. Flag when a plain "and" would work. Leave alone when the contrast is real.
- Rejecting an objection nobody raised ("You might think X. But..."). Flag when no such objection appears. Leave alone when the writer quotes or names it.
- Aphorism-style lines that dress up an ordinary point as a hidden truth. Flag when the line says nothing the previous sentence did not. Leave alone in a deliberate rhetorical flourish that is rare in the piece.

Formulaic openers and closers (all generic_phrasing)
- Announcing the point before making it ("In this essay, we will explore", "It is important to note that", "Let's dive in"). Flag when cutting the announcement loses nothing. Leave alone in a thesis sentence an assignment asks for.
- Staged candor ("Here's the thing", "Let me be honest") before a plain statement. Flag when the plain statement can stand alone. Leave alone in conversational writing where the writer's voice uses it.
- A closing line that restates the paragraph or ends on a vague upbeat verdict ("continues to thrive", "the future looks bright"). Flag when it repeats or adds no fact. Leave alone when it states a real conclusion.
- A one-line punchy fragment that just echoes the previous sentence. Flag when it is an echo. Leave alone when it adds a new turn.
- Chatbot residue left in a finished piece ("As an AI language model", "Certainly! Here is", praise for the question such as "Great question"). Flag it. Leave alone ordinary email sign-offs and courtesies, which are normal between people.

Forced triads (all generic_phrasing)
- Three items listed because three feels complete, where one is padding ("clear, concise and compelling"). Flag when two items mean the same thing. Leave alone when each item is distinct and the content really has three parts.
- Three parallel clauses or sentences with the same shape and no new information in the third. Flag when the third repeats the first two. Leave alone for a real list of three steps or facts.
- Pairs of near-synonyms ("quick and rapid", "tools and resources"). Flag when one word is enough. Leave alone in fixed expressions.

Vague attribution (all generic_phrasing)
- "Experts say", "studies show", "many believe", "observers note" with no one named. Flag only when the sentence names no person, organization, document or date behind the claim. Leave alone when any of those is named, or the claim is common knowledge.
- "Industry reports" or a list of famous outlets as proof, with no specific source. Flag when nothing specific is cited. Leave alone when the citation is given.
- Inflating how many people agree ("widely regarded", "many consider"). Flag when no evidence is offered. Leave alone for genuinely uncontroversial facts.
- A source quoted or paraphrased with the verb "highlights" or "underscores" where "says" would do. Flag when the verb overstates. Leave alone when the source does emphasize the point.

Filler transitions (all generic_phrasing)
- Sentences opening with "Additionally", "Moreover" or "Furthermore" in a run. Flag only when two or more such openers appear in the same paragraph. A single one is never flagged, and leave alone "In conclusion," wherever it opens a real concluding sentence.
- "It is worth noting that" and "Importantly," ahead of an ordinary statement. Flag and suggest dropping it. Leave alone when the thing really is a warning.
- "In today's fast-paced world" and similar throat-clearing scene-setting. Flag in any opening. Leave alone when the writer is quoting it.
- "Overall," "Ultimately," or "At the end of the day" ahead of a sentence that repeats what came before. Flag when the sentence only restates an earlier one, or when two of them are stacked. Leave alone a single one that opens a real conclusion.
- Hedges stacked on one claim ("may potentially", "could possibly suggest"). Flag when two or more qualify one point. Leave alone when the uncertainty is real and stated once.`;

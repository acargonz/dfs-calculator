/**
 * Universal DFS text parser.
 * Handles pasted text from PrizePicks, Underdog Fantasy, DraftKings Pick6, etc.
 */

export interface ParsedPlayer {
  playerName: string;
  line: number;
  statType: string;
  direction: 'over' | 'under';
}

/**
 * Normalize raw stat type strings into our canonical stat types.
 * Handles various formats from different DFS apps.
 */
export function normalizeStatType(raw: string): string {
  const s = raw.toLowerCase().trim();

  // Direct matches
  if (s === 'points' || s === 'pts') return 'points';
  if (s === 'rebounds' || s === 'rebs' || s === 'reb') return 'rebounds';
  if (s === 'assists' || s === 'asts' || s === 'ast') return 'assists';
  if (s === 'steals' || s === 'stl' || s === 'stls') return 'steals';
  if (s === 'blocks' || s === 'blk' || s === 'blks') return 'blocks';
  if (s === 'threes' || s === '3-pointers' || s === '3-pt' || s === '3pt'
    || s === 'three pointers' || s === '3pm' || s === 'threes made'
    || s === '3-pointers made' || s === 'three-pointers made') return 'threes';

  // Combo stats — not directly supported but recognizable
  if (s === 'pts+rebs+asts' || s === 'pra' || s === 'pts + rebs + asts') return 'pra';
  if (s === 'pts+rebs' || s === 'pr' || s === 'pts + rebs') return 'pts+rebs';
  if (s === 'pts+asts' || s === 'pa' || s === 'pts + asts') return 'pts+asts';
  if (s === 'rebs+asts' || s === 'ra' || s === 'rebs + asts') return 'rebs+asts';
  if (s === 'fantasy points' || s === 'fantasy score' || s === 'fpts') return 'fantasy';

  return s; // Return as-is if no match
}

/**
 * Detect the direction from a keyword.
 */
export function parseDirection(raw: string): 'over' | 'under' {
  const s = raw.toLowerCase().trim();
  if (s === 'under' || s === 'less' || s === 'lower' || s === 'fewer') return 'under';
  return 'over'; // "over", "more", "higher", or default
}

/**
 * Parse pasted DFS text into structured player entries.
 *
 * Handles multiple formats:
 * - PrizePicks: "Player Name\nMore\nStat Type\n24.5"
 * - Underdog: "Player Name\nHigher\n24.5 Stat Type"
 * - General: "Player Name  24.5 Points  Over"
 *
 * Strategy: Look for lines with numbers (the line value),
 * associate with nearest player name and stat type.
 */
export function parseDFSText(text: string): ParsedPlayer[] {
  const results: ParsedPlayer[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (lines.length === 0) return results;

  // Direction keywords
  const DIRECTION_WORDS = new Set(['more', 'less', 'over', 'under', 'higher', 'lower', 'fewer']);

  // Stat keywords (before normalization)
  const STAT_PATTERNS = /\b(points|pts|rebounds|rebs|reb|assists|asts|ast|steals|stl|stls|blocks|blk|blks|threes|3-pointers?|3-?pt|3pm|three[ -]?pointers?( made)?|threes made|pts\+rebs\+asts|pra|pts\+rebs|pts\+asts|rebs\+asts|fantasy points|fantasy score|fpts)\b/i;

  // Number pattern: matches "24.5", "24", etc.
  const NUMBER_PATTERN = /\b(\d+(?:\.\d+)?)\b/;

  let currentName = '';
  let currentDirection: 'over' | 'under' = 'over';
  let currentStat = '';
  let currentLine: number | null = null;

  function flush() {
    if (currentName && currentLine !== null && currentStat) {
      results.push({
        playerName: currentName,
        line: currentLine,
        statType: normalizeStatType(currentStat),
        direction: currentDirection,
      });
    }
    currentName = '';
    currentDirection = 'over';
    currentStat = '';
    currentLine = null;
  }

  for (const line of lines) {
    const lower = line.toLowerCase();

    // Check if this line is just a direction word
    if (DIRECTION_WORDS.has(lower)) {
      currentDirection = parseDirection(lower);
      continue;
    }

    // Check if this line has a number and a stat type (e.g., "24.5 Points" or "Points 24.5")
    const statMatch = line.match(STAT_PATTERNS);
    const numMatch = line.match(NUMBER_PATTERN);

    if (statMatch && numMatch) {
      // Check if the number is part of the stat name (e.g., "3" in "3-Pointers")
      const numStart = line.indexOf(numMatch[1]);
      const numEnd = numStart + numMatch[1].length;
      const statStart = line.indexOf(statMatch[1]);
      const statEnd = statStart + statMatch[1].length;
      const numInsideStat = numStart >= statStart && numEnd <= statEnd;

      if (numInsideStat) {
        // Number is part of the stat name — treat as stat-only line
        currentStat = statMatch[1];
      } else {
        // Line contains both stat type and a separate number — stat+line combo
        if (currentName && currentLine !== null && currentStat) {
          flush();
        }
        currentStat = statMatch[1];
        currentLine = parseFloat(numMatch[1]);

        if (currentName) {
          flush();
        }
      }
      continue;
    }

    if (statMatch && !numMatch) {
      // Just a stat type on its own line
      currentStat = statMatch[1];
      continue;
    }

    if (numMatch && !statMatch) {
      // Just a number on its own line — treat as the line value
      currentLine = parseFloat(numMatch[1]);

      // If we have all pieces, flush
      if (currentName && currentStat) {
        flush();
      }
      continue;
    }

    // No stat or number — likely a player name
    // But only if the line looks like a name (2+ chars, not a direction word)
    if (line.length >= 2 && !DIRECTION_WORDS.has(lower)) {
      // If we have a pending complete entry, flush first
      if (currentName && currentLine !== null && currentStat) {
        flush();
      }
      // If we already have a name but no stat/line yet, this is a new name (reset)
      if (currentName && currentLine === null && !currentStat) {
        currentName = line;
      } else {
        currentName = line;
      }
    }
  }

  // Flush any remaining entry
  flush();

  return results;
}

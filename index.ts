#!/usr/bin/env node
import axios from 'axios';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

const FIREBASE_BASE = 'https://hacker-news.firebaseio.com/v0';
const ALGOLIA_BASE = 'https://hn.algolia.com/api/v1';

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'mcp-claude-hackernews (+https://github.com/imprvhub/mcp-claude-hackernews)' },
});

interface Story {
  id: number;
  title: string;
  by: string;
  time: number;
  url?: string;
  score: number;
  kids?: number[];
  descendants?: number;
  text?: string;
  type: string;
}

interface Comment {
  id: number;
  by: string;
  time: number;
  text: string;
  kids?: number[];
}

interface FormattedStory {
  id: number;
  title: string;
  by: string;
  time: string;
  url?: string;
  score: number;
  commentsCount: number;
  text?: string;
}

interface FormattedComment {
  id: number;
  by: string;
  time: string;
  text: string;
  replies: number;
}

type Feed = 'newstories' | 'topstories' | 'beststories';

class HackerNewsAPI {
  async getStories(feed: Feed, limit: number): Promise<Story[]> {
    const { data } = await http.get<number[]>(`${FIREBASE_BASE}/${feed}.json`);
    const ids = (data || []).slice(0, limit);
    const items = await Promise.all(ids.map(id => this.getItemDetails(id)));
    return items.filter((s): s is Story => s !== null && (s as Story).type === 'story');
  }

  async getItemDetails(itemId: number): Promise<Story | Comment | null> {
    try {
      const { data } = await http.get(`${FIREBASE_BASE}/item/${itemId}.json`);
      return data;
    } catch (error) {
      console.error(`Error fetching item ${itemId}:`, error instanceof Error ? error.message : error);
      return null;
    }
  }

  async getComments(commentIds: number[] = [], limit: number): Promise<Comment[]> {
    if (!commentIds.length) return [];
    const items = await Promise.all(commentIds.slice(0, limit).map(id => this.getItemDetails(id)));
    // Deleted/dead comments come back without text; they would render as empty blocks.
    return items.filter((c): c is Comment => c !== null && typeof (c as Comment).text === 'string');
  }

  async search(query: string, limit: number, sort: 'relevance' | 'date'): Promise<FormattedStory[]> {
    const path = sort === 'date' ? 'search_by_date' : 'search';
    const { data } = await http.get(`${ALGOLIA_BASE}/${path}`, {
      params: { query, tags: 'story', hitsPerPage: limit },
    });
    return (data?.hits || []).map((hit: any) => ({
      id: Number(hit.objectID),
      title: hit.title || hit.story_title || 'No title',
      by: hit.author,
      time: formatTime(Math.floor(new Date(hit.created_at).getTime() / 1000)),
      url: hit.url || undefined,
      score: hit.points ?? 0,
      commentsCount: hit.num_comments ?? 0,
      text: hit.story_text ? cleanText(hit.story_text) : undefined,
    }));
  }
}

/** Unix seconds -> ISO 8601 UTC. Stable across host locales, unlike toLocaleString(). */
function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace('.000Z', 'Z');
}

/** HN serves comment bodies as HTML with numeric entities; strip tags and decode. */
function cleanText(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}

function toFormatted(story: Story): FormattedStory {
  return {
    id: story.id,
    title: story.title,
    by: story.by,
    time: formatTime(story.time),
    url: story.url,
    score: story.score,
    // descendants is the full thread count; kids is only direct replies.
    commentsCount: story.descendants ?? story.kids?.length ?? 0,
  };
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? Math.floor(value) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}

const api = new HackerNewsAPI();
let lastStoriesList: FormattedStory[] = [];

const server = new Server(
  { name: 'mcp-claude-hackernews', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

const limitProp = (max: number, def: number) => ({
  type: 'number' as const,
  description: `Number of items to fetch (1-${max}, default: ${def})`,
  minimum: 1,
  maximum: max,
  default: def,
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hn_latest',
      description: 'Get the latest/newest stories from Hacker News',
      inputSchema: { type: 'object', properties: { limit: limitProp(50, 10) } },
    },
    {
      name: 'hn_top',
      description: 'Get the top-ranked stories from Hacker News',
      inputSchema: { type: 'object', properties: { limit: limitProp(50, 10) } },
    },
    {
      name: 'hn_best',
      description: 'Get the best stories from Hacker News',
      inputSchema: { type: 'object', properties: { limit: limitProp(50, 10) } },
    },
    {
      name: 'hn_search',
      description: 'Search Hacker News stories by keyword, via the Algolia HN Search API',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search terms, e.g. "rust async" or "claude mcp"' },
          limit: limitProp(50, 10),
          sort: {
            type: 'string',
            enum: ['relevance', 'date'],
            description: 'Rank by relevance (default) or most recent first',
            default: 'relevance',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'hn_story',
      description: 'Get details for a specific story by ID',
      inputSchema: {
        type: 'object',
        properties: { story_id: { type: 'number', description: 'The ID of the story to fetch' } },
        required: ['story_id'],
      },
    },
    {
      name: 'hn_comments',
      description: 'Get top-level comments for a story (by story ID or index from the last story list)',
      inputSchema: {
        type: 'object',
        properties: {
          story_id: { type: 'number', description: 'The ID of the story to get comments for' },
          story_index: {
            type: 'number',
            description: 'The index (1-based) of the story from the last fetched list',
            minimum: 1,
          },
          limit: limitProp(50, 20),
        },
      },
    },
  ],
}));

const text = (body: string) => ({ content: [{ type: 'text', text: body }] });

const FEEDS: Record<string, Feed> = {
  hn_latest: 'newstories',
  hn_top: 'topstories',
  hn_best: 'beststories',
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name in FEEDS) {
      const limit = clampLimit(args?.limit, 10, 50);
      const stories = (await api.getStories(FEEDS[name], limit)).map(toFormatted);
      lastStoriesList = stories;
      return text(formatStoriesAsText(stories));
    }

    if (name === 'hn_search') {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query) throw new Error('A non-empty "query" is required');
      const sort = args?.sort === 'date' ? 'date' : 'relevance';
      const stories = await api.search(query, clampLimit(args?.limit, 10, 50), sort);
      lastStoriesList = stories;
      return text(
        stories.length
          ? `Results for "${query}" (sorted by ${sort}):\n\n${formatStoriesAsText(stories)}`
          : `No stories found for "${query}".`
      );
    }

    if (name === 'hn_story') {
      const storyId = typeof args?.story_id === 'number' ? args.story_id : NaN;
      if (Number.isNaN(storyId)) throw new Error('Story ID must be a number');
      const story = (await api.getItemDetails(storyId)) as Story | null;
      if (!story) throw new Error(`Story with ID ${storyId} not found`);
      return text(
        formatStoryAsText({ ...toFormatted(story), text: story.text ? cleanText(story.text) : '' })
      );
    }

    if (name === 'hn_comments') {
      const storyId = typeof args?.story_id === 'number' ? args.story_id : NaN;
      const storyIndex = typeof args?.story_index === 'number' ? args.story_index : NaN;

      let targetStoryId: number;
      if (!Number.isNaN(storyId)) {
        targetStoryId = storyId;
      } else if (storyIndex > 0 && storyIndex <= lastStoriesList.length) {
        targetStoryId = lastStoriesList[storyIndex - 1].id;
      } else if (Number.isNaN(storyIndex)) {
        throw new Error('Either a story ID or a story index is required');
      } else {
        throw new Error(
          `Story index ${storyIndex} is out of range; the last list held ${lastStoriesList.length} stories`
        );
      }

      const story = (await api.getItemDetails(targetStoryId)) as Story | null;
      if (!story) throw new Error(`Story with ID ${targetStoryId} not found`);

      if (!story.kids?.length) {
        return text(`No comments found for story "${story.title}" (ID: ${story.id})`);
      }

      const limit = clampLimit(args?.limit, 20, 50);
      const comments = await api.getComments(story.kids, limit);
      const formatted: FormattedComment[] = comments.map(c => ({
        id: c.id,
        by: c.by,
        time: formatTime(c.time),
        text: cleanText(c.text),
        replies: c.kids?.length ?? 0,
      }));
      return text(formatCommentsAsText(story.title, formatted, story.kids.length));
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    console.error('Error handling request:', error);
    throw error;
  }
});

function formatStoriesAsText(stories: FormattedStory[]): string {
  if (!stories.length) return 'No stories found.';
  return stories
    .map((story, index) =>
      [
        `${index + 1}. ${story.title}`,
        `   ID: ${story.id}`,
        `   By: ${story.by}`,
        `   Published: ${story.time}`,
        `   Score: ${story.score}`,
        `   Comments: ${story.commentsCount}`,
        `   URL: ${story.url || `https://news.ycombinator.com/item?id=${story.id}`}`,
        '   ------------------------------',
      ].join('\n')
    )
    .join('\n\n');
}

function formatStoryAsText(story: FormattedStory): string {
  let result = [
    `Title: ${story.title}`,
    `ID: ${story.id}`,
    `By: ${story.by}`,
    `Published: ${story.time}`,
    `Score: ${story.score}`,
    `Comments: ${story.commentsCount}`,
    `URL: ${story.url || `https://news.ycombinator.com/item?id=${story.id}`}`,
  ].join('\n');
  if (story.text) result += `\n\nContent:\n${story.text}`;
  return result;
}

function formatCommentsAsText(
  storyTitle: string,
  comments: FormattedComment[],
  totalTopLevel: number
): string {
  if (!comments.length) return 'No comments found.';
  const shown =
    comments.length < totalTopLevel
      ? `showing ${comments.length} of ${totalTopLevel} top-level`
      : `${comments.length} top-level`;
  const header = `Comments for "${storyTitle}" (${shown}):\n`;
  const body = comments
    .map((comment, index) =>
      [
        `${index + 1}. Comment by ${comment.by} at ${comment.time}:`,
        `   "${comment.text}"`,
        `   ${comment.replies > 0 ? `(${comment.replies} replies)` : '(no replies)'}`,
        '   ------------------------------',
      ].join('\n')
    )
    .join('\n\n');
  return `${header}\n${body}`;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Hacker News server running on stdio');
}

// Only start the transport when run as a program; importing this module (tests) must not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('Fatal error in main():', error);
    process.exit(1);
  });
}

export { cleanText, formatTime, clampLimit, formatStoriesAsText };

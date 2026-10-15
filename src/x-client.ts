import type { XPost } from "./types";

type RawUserResponse = {
  data?: { id: string; username: string };
  detail?: string;
  title?: string;
};

type RawMedia = {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
};

type RawPost = {
  id: string;
  text: string;
  created_at?: string;
  attachments?: { media_keys?: string[] };
  note_tweet?: { text?: string };
  edit_history_tweet_ids?: string[];
  author_id?: string;
  referenced_tweets?: { type: string; id: string }[];
};

type RawPostsResponse = {
  data?: RawPost[];
  errors?: unknown[];
  includes?: { media?: RawMedia[]; tweets?: RawPost[] };
  meta?: { newest_id?: string; next_token?: string; result_count?: number };
  detail?: string;
  title?: string;
};

export class XClient {
  constructor(
    private readonly bearerToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private normalize(post: RawPost, username: string, userId: string,
    includes: RawPostsResponse["includes"], depth = 0): XPost {
    const parent = post.referenced_tweets?.find(r => r.type === "replied_to");
    const quote = post.referenced_tweets?.find(r => r.type === "quoted");
    const related = (id: string | undefined) => includes?.tweets?.find(t => t.id === id);
    const own = (id: string | undefined) => id && (!related(id) || related(id)!.author_id === userId);
    const media = includes?.media ?? [];
    return { id: post.id, canonicalId: post.edit_history_tweet_ids?.[0] ?? post.id,
      text: post.note_tweet?.text || post.text, createdAt: post.created_at ?? null,
      url: `https://x.com/${username}/status/${post.id}`, authorUsername: username,
      media: (post.attachments?.media_keys ?? []).flatMap(key => {
        const item = media.find(m => m.media_key === key);
        return item ? [{ mediaKey: item.media_key, type: item.type, url: item.url ?? null,
          previewImageUrl: item.preview_image_url ?? null, altText: item.alt_text ?? null }] : [];
      }),
      ...(own(parent?.id) ? { replyToId: parent!.id } : {}),
      ...(own(quote?.id) ? { quotedPostId: quote!.id,
        ...(related(quote!.id) && depth < 3 ? { quotedPost: this.normalize(related(quote!.id)!, username, userId, includes, depth + 1) } : {}) } : {}) };
  }

  async getPost(id: string, username: string, userId: string): Promise<XPost> {
    if (!/^\d+$/.test(id)) throw new Error("Invalid X reference");
    const url = new URL(`https://api.x.com/2/tweets/${id}`);
    url.searchParams.set("tweet.fields", "created_at,text,author_id,note_tweet,referenced_tweets");
    url.searchParams.set("expansions", "referenced_tweets.id");
    const body = await this.request<{ data?: RawPost; errors?: unknown[]; includes?: RawPostsResponse["includes"] }>(url);
    if (body.errors?.length || body.data?.id !== id || body.data.author_id !== userId)
      throw new Error("X reference missing or author mismatch");
    return this.normalize(body.data, username, userId, body.includes);
  }

  private async request<T>(url: URL): Promise<T> {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "User-Agent": "reset-signal/1.0",
      },
    });

    const body = (await response.json()) as T & {
      detail?: string;
      title?: string;
    };
    if (!response.ok) {
      const message = `X API returned ${response.status}`;
      throw new Error(message);
    }
    return body;
  }

  async resolveUserId(username: string): Promise<string> {
    const url = new URL(
      `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`,
    );
    const body = await this.request<RawUserResponse>(url);
    if (!body.data?.id) throw new Error(`X user @${username} was not found.`);
    return body.data.id;
  }

  async getPosts(options: {
    userId: string;
    username: string;
    sinceId?: string | null;
    excludeReplies?: boolean;
    bootstrap?: boolean;
  }): Promise<{ posts: XPost[]; newestId: string | null }> {
    const url = new URL(`https://api.x.com/2/users/${options.userId}/tweets`);
    url.searchParams.set("max_results", "100");
    url.searchParams.set(
      "tweet.fields",
      "attachments,created_at,note_tweet,text,author_id,edit_history_tweet_ids,referenced_tweets",
    );
    url.searchParams.set("expansions", "attachments.media_keys,referenced_tweets.id");
    url.searchParams.set(
      "media.fields",
      "media_key,type,url,preview_image_url,alt_text",
    );
    url.searchParams.set(
      "exclude",
      options.excludeReplies ? "retweets,replies" : "retweets",
    );
    if (options.sinceId) url.searchParams.set("since_id", options.sinceId);

    const allPosts = new Map<string, XPost>();
    const tokens = new Set<string>();
    let latest: string | null = null;
    do {
      const body = await this.request<RawPostsResponse>(url);
      if (body.errors?.length)
        throw new Error(
          "X timeline returned partial errors; cursor not advanced",
        );
      if (!Array.isArray(body.data) && body.meta?.result_count !== 0)
        throw new Error("Invalid X timeline response");
      const posts = (body.data ?? [])
        .filter((post) => !post.author_id || post.author_id === options.userId)
        .map(
          (post): XPost => this.normalize(post, options.username, options.userId, body.includes),
        );

      for (const post of posts) {
        if (!/^\d+$/.test(post.id)) throw new Error("Invalid X post ID");
        allPosts.set(post.id, post);
        if (!latest || BigInt(post.id) > BigInt(latest)) latest = post.id;
      }
      // First run only establishes a baseline; later runs drain the entire backlog.
      if (options.bootstrap || !body.meta?.next_token) break;
      if (tokens.has(body.meta.next_token) || tokens.size >= 100)
        throw new Error("X pagination incomplete; cursor not advanced");
      tokens.add(body.meta.next_token);
      url.searchParams.set("pagination_token", body.meta.next_token);
    } while (true);
    return { posts: [...allPosts.values()], newestId: latest };
  }
}

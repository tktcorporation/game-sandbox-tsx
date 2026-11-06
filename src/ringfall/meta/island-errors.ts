/*
 * Every error the island API answers with (worker/api.ts, worker/island.ts), and what the game says
 * for each (docs/ringfall/multiplayer.md, 島の番号と遠征の API). The Worker types its refusals with
 * `ApiError`, so a code it can send is always one listed here, and `ERROR_TEXT` must name each one.
 * A leaf module, shared by the Worker and the browser.
 */

/** The `error` of a refusal the API can send. */
export const API_ERRORS = [
  // The bindings.
  "no-database",
  "no-island-server",
  "db-error",
  "island-error",
  // The request.
  "bad-request",
  "too-large",
  "not-found",
  "method-not-allowed",
  "unauthorized",
  // Islands.
  "no-free-code",
  "code-taken",
  "no-island",
  "not-owner",
  "own-island",
  "no-own-island",
  // Expeditions.
  "closed-node",
  "node-not-open",
  "protected",
  "node-busy",
  "island-full",
  "day-limit",
  "too-many-units",
] as const;

export type ApiError = (typeof API_ERRORS)[number];

/** Failures the browser meets before or apart from an answer: no connection, or an answer it cannot read. */
export type NetError = "network" | "bad-response";

/** What the factory's panel says for each failure, in a line. */
export const ERROR_TEXT: Record<ApiError | NetError, string> = {
  "no-database": "島のサーバーにつながっていません",
  "no-island-server": "島のサーバーにつながっていません",
  "db-error": "サーバーが記録できませんでした",
  "island-error": "島のサーバーが答えませんでした",
  "bad-request": "送った内容が読めませんでした",
  "too-large": "送った内容が大きすぎます",
  "not-found": "見つかりません",
  "method-not-allowed": "送り方が違います",
  unauthorized: "自分の島だと示せませんでした",
  "no-free-code": "島の番号を引けませんでした。あとでもう一度",
  "code-taken": "その番号はもう使われています",
  "no-island": "その番号の島はありません",
  "not-owner": "この端末の島ではありません",
  "own-island": "自分の島には送れません",
  "no-own-island": "自分の島の番号がまだありません",
  "closed-node": "その拠点は遠征で取れません",
  "node-not-open": "その拠点は他のプレイヤーが持っています",
  protected: "始めたばかりの島です。保護が明けるまで待つ",
  "node-busy": "その拠点にはもう遠征隊が向かっています",
  "island-full": "その島には遠征隊がいっぱいです",
  "day-limit": "その島は今日の分を取られました。明日もう一度",
  "too-many-units": "工場の部隊より多くは送れません",
  network: "つながりませんでした",
  "bad-response": "サーバーの答えが読めませんでした",
};

/** Whether `s` is one of the API's error codes. */
export const isApiError = (s: unknown): s is ApiError => typeof s === "string" && (API_ERRORS as readonly string[]).includes(s);

/** The line for a failure; an unknown code reads as an answer the game cannot read. */
export const errorText = (e: string): string => (isApiError(e) || e === "network" || e === "bad-response" ? ERROR_TEXT[e as ApiError | NetError] : ERROR_TEXT["bad-response"]);

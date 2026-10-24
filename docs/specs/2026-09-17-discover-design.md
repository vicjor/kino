# Discover and recommendations (2026-09-17)

Status: Shipped 2026-09-24, current.

What makes a rail worth scrolling. Every choice in `server/discover.ts`, `server/taste.ts` and the Browse screen follows from these.

## The soul

1. **Every rail answers a question you might actually have.** "What next, after the show I just finished?" "What is new and good?" "What is everyone watching?" "I want a thriller tonight." A rail that answers none of these is not shown.
2. **Real similarity, not genre buckets.** "Because you watched X" uses TMDB's co-watch recommendations (people who watched X also watched Y). Cinemeta's genre shelf is only the fallback without a key. TMDB's "similar" endpoint is keyword overlap and lands on nonsense; it is never used.
3. **Never show what you have seen.** Anything in progress (any percentage), on the watchlist or followed is gone from the rails, and a title lives in one rail only. Browse marks seen titles instead of hiding them, because there you are looking, not being shown.
4. **Weight by what you actually did.** Finished beats abandoned, eight episodes beat one, last week beats last spring (half the pull is gone after six weeks). A show closed after a minute is not a signal. See `seeds()`.
5. **Say why.** Each rail has a reason line in plain words: "You watched 8 episodes", "Loved by the few who have seen them", "Out in the last year, rated well".
6. **It changes.** Genre order and the third "because you watched" seed rotate once a day. Not random per reload; the same Home for a day, a different one tomorrow.
7. **You can steer.** Browse by kind, genre and sort, with the filters in the URL so a rail's "See all" and a mood tile are just links. Moods ("Make me laugh", "Keep me on edge") are genre shelves with a sort, nothing cleverer, so they always have something in them.
8. **Stay in your language, quietly.** When seventy percent or more of your watching is in one original language, the rails that are not seeded by a title (new, gems, top rated) stay in it. Under that, no filter.
9. **Fast and quiet.** Rails are built in the background, kept on disk (`~/kino-data/discover.json`) and served in milliseconds; rebuilt when older than thirty minutes or when the top seeds change. A rail that fails is dropped, never an error on Home. Fewer than six items and the rail is not shown.

## Rails, in order

| Key | Source | Why it is there |
|---|---|---|
| Trending this week | TMDB trending | What the world is watching |
| Because you watched X (up to 3) | TMDB recommendations, Cinemeta genre fallback | Your two heaviest seeds plus one rotating daily among the next three |
| New and worth it | TMDB discover, last 365 days, enough votes, rated well | New, but not junk |
| Genre series/movies | Cinemeta top by your top genre | You watch a lot of this |
| Hidden gems | Candidates: co-watch recommendations of your seeds that have no rail of their own (four each), plus TMDB discover best rated in your top three genres since 2000. IMDb decides: 5k to 60k votes and 8.0+ for series, 10k to 120k and 7.5+ for films, ranked by distance above that floor, nudged for co-watch and your genres. Noise genres and stand-up specials (films that are only Comedy) are out | Loved by the few who have seen them. TMDB vote counts are no proxy for IMDb (The Pitt: under 3000 votes on TMDB, 170k on IMDb), so IMDb draws the line |
| Top rated genre | TMDB's most voted in the genre, ordered by IMDb weighted rating from the local dumps (Cinemeta featured without a key) | Highest rated, widely seen. TMDB's own TV score is fan-driven, IMDb's with enough votes is not |
| Genre of the other kind | Cinemeta top | Balance movies and series by your series share |
| Popular now | Cinemeta top, both kinds interleaved | The baseline |

## Noise

Best-rated shelves leave out kids, reality, talk, news, soap and documentaries (series), documentaries, music and TV movies (films), and animation and family unless they are in your top genres. A genre you asked for is never left out. Without this, top rated comedy series is Rick and Morty and Gravity Falls. See `shelfNoise()`.

Every card gets IMDb's score from an in-memory index of the dump (titles with 1000+ votes), so the whole app speaks one scale: rails, Browse, Popular, watchlist, following and search. Cinemeta sometimes sends "" (or "N/A", "0") for a score; that counts as missing and is filled from the index.

## Costs

A cold build is a few hundred small TMDB calls (one per item for the IMDb id), gated at eight in flight, four seconds on a good day. Hidden gems is the biggest: eight discover pages and up to six seeds' recommendations, most of it cached. Ids are cached a week, lists six hours, the built rails half an hour on disk. Without a TMDB key everything still works from Cinemeta alone.

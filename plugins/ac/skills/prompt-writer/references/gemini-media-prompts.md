# Gemini Media Prompts

How to write the prompt for the `ac` MCP tools `generate_image`, `generate_video` and `generate_music`. They do not reach a Gemini API: the prompt travels through kodizm to a bridge that drives the consumer Gemini web app, so the first reader of your text is a Gemini chat model, and only then the image, video or music model. Each claim carries a label: **Doc** (a Google page), **Code** (kodizm or the bridge, read 2026-11-23), **Measured** (a live call through this tool) and **Inference** (this file's reading).

Primary sources, fetched 2026-11-23:

- Gemini Apps Help, images: https://support.google.com/gemini/answer/14286560
- Gemini Apps Help, video: https://support.google.com/gemini/answer/16126339
- Gemini Apps Help, music: https://support.google.com/gemini/answer/16901237
- Image generation (API): https://aistudio.google.com/docs/image-generation.md.txt
- Ultimate prompting guide for Nano Banana (Google Cloud blog, Mar 2026): https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-nano-banana
- Nano Banana Pro prompting tips: https://blog.google/products/gemini/prompting-tips-nano-banana-pro/
- Image prompt guide (DeepMind): https://deepmind.google/models/gemini-image/prompt-guide/
- Vertex image generation best practices (fetched 2026-11-16): https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/gemini-image-generation-best-practices
- Gemini Omni video (API): https://ai.google.dev/gemini-api/docs/omni.md.txt
- Video prompt guide (Vertex, covers Omni Flash and Veo): https://cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide
- Ultimate prompting guide for Veo 3.1: https://cloud.google.com/blog/products/ai-machine-learning/ultimate-prompting-guide-for-veo-3-1
- Music generation (API): https://ai.google.dev/gemini-api/docs/music-generation.md.txt
- Lyria prompt guide: https://ai.google.dev/gemini-api/docs/lyria-prompt-guide.md.txt
- Music prompt guide (Vertex): https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/music/music-gen-prompt-guide
- Tips for prompting Lyria 3 (Gemini blog): https://blog.google/products-and-platforms/products/gemini/tips-prompting-lyria-3/

The media models this path reached, read off the bridge's request log (`upstream_model`) in kodizm's own testing on 2026-11-23: Nano Banana 2.1 for `gemini-image` with no model, `hydrogen` and `neon`, with and without thinking, and Lyria 3.5 on every music call that produced a track. **Measured**

Not verified: whether the app's chat model rewrites your text before the media model sees it (no Google page says), which video model this path reaches, and the resolution the app renders video at.

## The path a prompt takes

1. The tool call goes to kodizm, which folds the options into the text or into fields (below) and sends one user message to the bridge. **Code**
2. The bridge opens gemini.google.com with the matching tool selected (Create image, Create music, Create video) and a chat model: for an image the model you pass (`neon` by default through the proxy, or `hydrogen`), for video and music the 3.6 Flash model. **Code**
3. The chat model reads your prompt as a user turn and calls the media model: Nano Banana 2.1 for images and Lyria 3.5 for music (**Measured**, above), and per the Help page Gemini Omni Flash for video ("Gemini Omni 1.2 Flash, our latest AI video generation model"; **Doc**, that this path reaches it **Inference**).

What this means for the text:

- **Make the request unmistakable.** Google's tips for all three open with a creation verb: images "Start your prompt with words like draw, generate, and create", music "Start your prompt with words like write, compose, or create". Vertex's image page gives the reason: without such a phrase the model "might respond with text instead of the image". **Doc** A chat model that reads a prompt as a question or a remark answers with text and makes nothing: a `chat_id` edit worded "Make the paper boat bright red" was answered with text twice, "Generate an image: the same paper boat, now bright red" drew. **Measured**, n=2 and n=1. Music fails this way most: a music turn whose stream ends within seconds is the chat model ("4 Hydrogen" in the log) answering with text instead of calling Lyria, 12 of 12 such turns made no track, and kodizm retries a music call up to five times for it. Wording does not cure it: Google's own Lyria example, opening with "Compose", failed all five tries of one call this way on 2026-11-23. So a failed music call is reported to the user, not reworded and sent again. **Measured**, **Code**
- **Address the media, not the chat model.** Leave out role lines ("You are an expert art director"), questions, requests to explain or confirm, and lines such as "do not reply with text": each one is something the chat model can answer in words. **Inference**
- **Put the whole brief in concrete description.** Whether the chat model passes your words on unchanged is undocumented, so a detail you only imply may not reach the media model; state it. Quoted text to render or sing is the part most likely to be kept verbatim. **Inference**
- **One deliverable per call.** "Make three versions" or "a video and a poster" leaves the chat model to choose (**Inference**); ask for one thing, and call again only when the user wants another. Every call draws on a shared quota, failed ones included. **Code**
- **Write in English** unless the words must be sung or shown in another language. English is first on the image guide's language list and the only language "fully supported" for Omni video. **Doc**

## Options: fields versus text

Some options reach Gemini as real menu settings, others as text appended after your prompt. Use the option rather than repeating it in prose, and never contradict it.

| Tool | Option | How it reaches Gemini |
|---|---|---|
| image | `aspect_ratio` (1:1, 9:16, 3:4, 4:3, 16:9), `size` | The Create image menu's ratio field; `size` maps to the nearest ratio. **Code** |
| image | `style` | One sentence after a blank line: a preset (`cinematic`, `y2k-stickers`, `technicolour`, `gothic-clay`, `sketch`, `steampunk`) expands to a fixed description, any other value becomes "In this style: <value>." **Code** |
| image | `model`, `thinking`, `chat_id` | Pick the chat model and its thinking tier, and continue one conversation. **Code** |
| video | `aspect_ratio` (16:9 or 9:16) | A field of the video request (1280x720 or 720x1280). **Code** |
| video | `duration_seconds`, `style`, `audio` | Lines after a blank line: `Duration: about N seconds`, `Style: ...`, `Audio: ...` or `Audio: none, silent video`. **Code** |
| music | `genre`, `vocals`, `length_seconds`, `mood`, `instruments` | Lines after a blank line: `Genre: ...`, `Vocals: ...` (`Vocals: none, instrumental only` for `instrumental`), `Length: about N seconds`, `Mood: ...`, `Instruments: ...`. **Code** |
| music | `lyrics` | Its own block, `Lyrics:` then your text, after the option lines; refused together with `vocals: instrumental`. **Code** |

Prompt and options together stay under 8,000 characters. **Code**

## Images (`generate_image`)

Rules, from the image guide, the Cloud guide and the Help page unless marked:

- **Describe a scene in connected prose**: subject, action, setting, composition and style ("Include subject, composition, action, location, and style"). State the purpose when it shapes the picture: a logo, a book cover, a product shot. **Doc**
- **Be specific.** "Ornate elven plate armor, etched with silver leaf patterns" beats "fantasy armor". **Doc**
- **Use photographic words for a photograph**: shot type, lens, light, angle ("A photorealistic [type of shot] of a [subject] in a [setting]. [Light]. Shot from a [camera angle] with a [lens type]."). **Doc**
- **Describe what you want, not what to avoid**: "an empty, deserted street" rather than "no cars". **Doc**
- **Quote every word to render** and describe the type: `the headline "EMBER" in bold white sans-serif at the top`. Keep it to a few words; "small text, fine details, and producing accurate spellings may not work perfectly". For longer copy Google's tip is to settle the wording first and then ask for the image with it. **Doc**
- **Break a crowded scene into steps**: "First, a background of ... Then, in the foreground ... Finally ...". **Doc**
- **Ratio by option.** Pass `aspect_ratio`; it is a real setting, where ratio words in the prompt are only a request the guide says "may not always" be honoured. With no ratio the result has been landscape (1408x768, 1376x768). **Code**, **Doc**, **Measured**
- **Expect seconds, not minutes**: a picture took about 13 to 25 seconds in the calls measured here. **Measured**

`model`: `neon` is the proxy default and needs a Pro account on kodizm's pool; `hydrogen` runs on any account unless the call also passes `thinking` or `chat_id`, which need Pro too. `thinking` (`low`, `medium`, `high`) sets the chat model's tier; leave it out unless a dense layout or an infographic came out wrong. **Code**; that thinking helps such pictures is **Inference**.

### Editing: a conversation or a reference

- **`chat_id` (a conversation).** Calls with the same `chat_id` are turns of one Gemini chat, so a follow-up sees the last picture and needs no reference. Word each follow-up as a new image request and say what stays: `Generate an image: the same paper boat, now bright red. Keep the puddle, the dawn light and the framing exactly the same.` Google: "Be explicit about what to keep exactly the same", and to keep a face or logo, "describe them in great detail along with your edit request". **Doc**, wording **Measured**
- A turn Gemini answers with text fails with `no_new_image`; the chat stays at the last good picture, so the retry reuses the same `chat_id` with plainer image wording. It still counts against the quota, so retry only when the user wants the edit. **Code**, **Measured**
- **A reference** edits one existing picture outside a conversation. `reference_image_path` takes the absolute path (or `~/...`) of one PNG, JPEG or WebP of at most 740,000 bytes, which a picture a previous call saved fits; `reference_image_url` takes the signed `image_url` of a previous result while its link is valid. Pass one of the two, never both, and only one per call: the guide's multi-reference mixing is not reachable here. A reference the proxy refuses generates and counts nothing. **Code**
- Google's edit templates, filled with the picture's own subject (**Doc**):
  - Change one thing: "Using the provided image, change only the [element] to [new element]. Keep everything else in the image exactly the same, preserving the original style, lighting, and composition."
  - Add or remove: "Using the provided image of [subject], please [add/remove/modify] [element] to/from the scene. Ensure the change is [how it should integrate]."
  - Style transfer: "Transform the provided photograph of [subject] into the artistic style of [art style]. Preserve the original composition but render it with [stylistic elements]."

Worked prompts (drafts):

```
Generate an image of a small red origami boat floating on calm blue water at sunrise. The sky is soft
peach and violet, low hills sit on the horizon, and the sun leaves a faint reflection on the water.
Minimalist flat illustration built from flat colour shapes, the boat just below the centre.
```
with `aspect_ratio: "16:9"`.

```
Create a poster for a small coffee roastery. The headline "EMBER" in bold white sans-serif at the top,
a steaming cup of dark coffee centred below it, warm amber backlight, deep brown background with fine
film grain. Clean editorial layout with generous empty space around the cup.
```
with `aspect_ratio: "9:16"`.

## Video (`generate_video`)

The app's video model makes clips of "3 seconds to up to 10 seconds" (15 on AI Ultra), landscape by default, and generates sound unless told otherwise. **Doc** There is no reference picture, start frame or negative-prompt field on this tool. **Code** A render takes minutes and video has the smallest quota, so the first prompt has to be the one.

- **Order the brief**: camera and shot, subject, action, setting, then style and ambience (Google's formula "[Cinematography] + [Subject] + [Action] + [Context] + [Style & Ambiance]"). Not every part is needed. **Doc**
- **Ask for one shot.** "By default Omni Flash will try to create a video with a few different shots"; for one scene write "In a single continuous shot" or "No scene cuts". **Doc**
- **Name the camera** with the guide's words: eye-level, low-angle, close-up, wide establishing shot, over-the-shoulder, POV; static, pan, tilt, dolly, crane, handheld, aerial; shallow depth of field, rack focus. **Doc**
- **Fit the action to the clip.** A few seconds hold one action, or two with a time cue ("After 3 seconds, a woman enters the scene", or a timecode such as `[0-5s] A person is walking down a quiet street`). Change over time should be "subtle for short clips". **Doc**
- **Sound in its own sentences**: "SFX: thunder cracks in the distance", "Ambient noise: the quiet hum of a starship bridge", music described plainly ("calm background music"). The `audio` option adds one `Audio:` line; use it for a short note or `none`, and put a richer soundscape in the prompt. **Doc**, **Code**
- **Dialogue**: name the speaker and give the line, short enough to say in the clip. The Vertex guide uses a colon, `The detective says: Your story has holes.`; the Veo 3.1 guide quotes it, `A woman says, "We have to leave now."`. Either form is Google's. **Doc**
- **Exclusions**: the API page says to put negatives in the prompt ("Do not do X") and lists "No dialogue", "No extra sound effects"; for visual elements describe the scene positively instead ("a desolate landscape with no buildings or roads"). If a clip with speech comes back with burned-in captions, add "No subtitles" to the next attempt: that remedy was reported for Veo and has not been seen needed on Omni. **Doc**, the subtitle remedy community-reported
- **On-screen text**: "If there will be naturally occurring text in your video ... it can help to define what it should say." **Doc**
- **Characters**: with no reference image, describe each person once in full (age, build, hair, clothes) and keep the same words throughout. **Doc** ("Be very specific")

Worked prompt (Google's example from the Omni page, with a creation verb added, **Inference**):

```
Generate a video: continuous, unbroken handheld shot of a fluffy tabby cat sitting on a sunny windowsill,
looking out into a leafy garden. The cat's tail twitches slowly, and its ears rotate slightly toward
ambient noises. Sunbeams illuminate dust motes in the air. Sound design: gentle breeze, distant bird
chirps. No dialogue.
```
with `aspect_ratio: "16:9"`, `duration_seconds: 8`.

## Music (`generate_music`)

The app's music model is Lyria; Google's guidance for it, from the Help page, the Lyria guide and the music API page:

- **Lead with the genre**, then mood, instruments, tempo and voice ("Lead your prompt with the primary genre"; Vertex order "[Genre & style] + [Mood] + [Instrumentation] + [Tempo & rhythm] + [Vocal style & language] + [Lyrics]"). Era and place sharpen a genre: "Early 1990s boom-bap hip-hop", "Berlin minimal techno". **Doc**
- **Be concrete**: "Mention instruments, BPM, key, mood, and structure" ("in G major at 122 BPM"). Unnamed instruments are chosen to suit the genre. **Doc**
- **A theme or a story** gives the track its lyrics when you supply none: "a song about my favourite meal my mom used to make". **Doc**
- **Vocals**: describe the voice by gender, range and timbre ("warm female vocal harmonies", "smooth baritone"). Pass `vocals: "instrumental"` for none; Lyria sings by default. **Doc**, **Code**
- **Lyrics**: pass them in `lyrics`, which kodizm sends as the `Lyrics:` block Google's guides use. Mark sections with `[Verse]`, `[Chorus]`, `[Bridge]` and backing vocals in parentheses, `(moving on)`. Keep them short for a short track. Lyria 3.5 "generates lyrics in the language of your prompt", so write the prompt in the language the song should be sung in. **Doc**, **Code**
- **Length**: the app offers "short (about 1 minute) or full (about 2-3 minutes)" tracks and says "To create a full track, switch the model to 'Pro'"; Lyria 3.5's length is "controllable using prompt". **Doc** The bridge runs music on the 3.6 Flash chat model, so expect about a minute; pass `length_seconds` for the wanted length and do not count on a full 2 to 3 minute song. **Code**, the outcome **Inference**
- **No artist names.** "Prompts that request specific artist voices" are blocked (**Doc**), and a blocked track still counts against the quota (**Code**); describe the genre, era and sound instead.

Worked prompt (Google's Lyria guide example, verb added, **Inference**):

```
Compose an upbeat, feel-good indie-pop song in G major at 122 BPM. Bright acoustic guitar strumming,
driving kick drum, handclaps, and warm female vocal harmonies. The lyrics describe an unforgettable
summer road trip with friends.
```

With your own words, the options carry the structure:

```
prompt:      Write a warm acoustic folk song for a friend's birthday, gentle and nostalgic.
vocals:      soft male tenor
instruments: fingerpicked acoustic guitar, light shaker
lyrics:      [Verse]
             Another year of open roads (open roads)
             [Chorus]
             Here's to you, here's to now
```

## Checklist before calling

- [ ] The prompt opens with a creation verb for its medium and reads as a request, with no role line, question or note to the chat model.
- [ ] One deliverable, described concretely; quoted text for anything to render or sing.
- [ ] Options set as options (image and video ratio, video duration and audio, music vocals and lyrics), not repeated or contradicted in prose.
- [ ] Image: scene in prose, ratio passed as `aspect_ratio`; an edit names what stays the same; a `chat_id` follow-up is worded as a new image request.
- [ ] Video: one continuous shot asked for, the action sized to the seconds, sound in its own sentences, exclusions as "No X" lines.
- [ ] Music: genre first, tempo and instruments named, vocals or `instrumental` decided, no artist names, about a minute expected.
- [ ] The call is one the user asked for; a failure is reported rather than retried unasked.

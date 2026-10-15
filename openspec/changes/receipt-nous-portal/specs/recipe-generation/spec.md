## ADDED Requirements

### Requirement: Nous-only model routing
The system SHALL send recipe-generation model requests exclusively to Nous Portal using an OpenAI model, defaulting to `openai/gpt-6.1-sol`.

#### Scenario: Legacy credentials remain in the parent environment
- **WHEN** the runtime inherits OpenRouter credentials or a legacy DeepSeek model setting
- **THEN** it SHALL never send a request to OpenRouter and SHALL reject unsupported model configuration

#### Scenario: Nous is unavailable
- **WHEN** credentials are absent, the request times out, or the provider returns an error or unusable response
- **THEN** the system SHALL use its existing valid database fallback without invoking another model provider

### Requirement: Source-grounded recipes
The system SHALL adapt recipes from fetched source material and preserve real source-image provenance without OpenRouter-specific plugins.

#### Scenario: A source candidate is available
- **WHEN** a non-recent recipe source from the database is successfully fetched
- **THEN** the system SHALL provide its recipe text to the model and anchor output source and image URLs to that source

#### Scenario: Source discovery fails
- **WHEN** no candidate page can be fetched or validated
- **THEN** the system SHALL use an eligible existing recipe or fail without posting, never invent source URLs

### Requirement: Preserve publishing constraints
The system SHALL preserve pork exclusion, variety checks, caption limits, real photographs, and the existing schedule and destination.

#### Scenario: Safe verification
- **WHEN** migration is smoke-tested
- **THEN** it SHALL use an isolated database and SHALL not send a Telegram publication or owner message

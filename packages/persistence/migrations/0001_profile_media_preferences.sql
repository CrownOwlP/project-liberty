CREATE TABLE "profile_media_preference" (
	"profile_id" text NOT NULL,
	"preferred_audio_languages" text[] NOT NULL,
	"preferred_subtitle_languages" text[] NOT NULL,
	"subtitle_mode" text NOT NULL,
	"hearing_impaired" boolean NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "profile_media_preference_pkey" PRIMARY KEY("profile_id")
);
--> statement-breakpoint
ALTER TABLE "profile_media_preference" ADD CONSTRAINT "profile_media_preference_profile_id_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile"("id") ON DELETE cascade ON UPDATE no action;
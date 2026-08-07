import { renderWelcomeCard } from "./welcome-card";

export function showsOnboardingGreeting(): boolean {
  return renderWelcomeCard("Ada") === "Welcome, Ada!";
}

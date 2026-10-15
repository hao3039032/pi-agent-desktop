cask "pi-agent" do
  version "0.7.0"
  sha256 "5f7e9c1031805dda495e0e8b7ed88b77701f2dd349bf74579e832362e18df233"

  url "https://github.com/abcwyc/pi-agent-desktop/releases/download/v#{version}/Pi.Agent_#{version}_aarch64.dmg"
  name "Pi Agent"
  desc "Local AI agent desktop app built on pi"
  homepage "https://github.com/abcwyc/pi-agent-desktop"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app upgrades itself from Settings with signed updater builds.
  auto_updates true
  depends_on arch: :arm64
  # The app builds against macOS 11 (Tauri `minimumSystemVersion`), which is also
  # Homebrew's own floor, so a bare `depends_on :macos` is the whole requirement.
  depends_on :macos

  app "Pi Agent.app"

  # Sessions, models and credentials live in ~/.pi and are shared with the pi
  # CLI, so they are deliberately not part of zap.
  zap trash: [
    "~/Library/Application Support/com.abcwyc.pi-agent",
    "~/Library/Caches/com.abcwyc.pi-agent",
    "~/Library/Preferences/com.abcwyc.pi-agent.plist",
    "~/Library/Saved Application State/com.abcwyc.pi-agent.savedState",
    "~/Library/WebKit/com.abcwyc.pi-agent",
  ]
end

cask "pi-agent" do
  version "0.6.4"
  sha256 "9ade7d801c95faeae37547e1674731e5431fd1ea2391749594fdd3c7b0a1950e"

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
  depends_on macos: ">= :big_sur"

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

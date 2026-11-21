"""System tray integration for Papilio Loader desktop application.

Provides a system tray icon with menu for controlling the server.
"""

import webbrowser
import threading
import sys
import logging
from pathlib import Path
from PIL import Image, ImageDraw
import pystray
from pystray import MenuItem as item

logger = logging.getLogger(__name__)


def create_icon_image():
    """Create a simple icon image for the system tray."""
    # Create a 64x64 icon with a circuit board pattern
    width = 64
    height = 64
    
    # Create base image with dark blue background
    image = Image.new('RGB', (width, height), color='#1e3a5f')
    draw = ImageDraw.Draw(image)
    
    # Draw a simple FPGA/chip representation
    # Draw chip outline
    chip_margin = 12
    draw.rectangle(
        [chip_margin, chip_margin, width - chip_margin, height - chip_margin],
        outline='#4fc3f7',
        width=2
    )
    
    # Draw chip pins (lines on edges)
    pin_length = 4
    pin_spacing = 8
    
    # Top and bottom pins
    for x in range(chip_margin + pin_spacing, width - chip_margin, pin_spacing):
        # Top pins
        draw.line([(x, chip_margin), (x, chip_margin - pin_length)], fill='#4fc3f7', width=2)
        # Bottom pins
        draw.line([(x, height - chip_margin), (x, height - chip_margin + pin_length)], fill='#4fc3f7', width=2)
    
    # Left and right pins
    for y in range(chip_margin + pin_spacing, height - chip_margin, pin_spacing):
        # Left pins
        draw.line([(chip_margin, y), (chip_margin - pin_length, y)], fill='#4fc3f7', width=2)
        # Right pins
        draw.line([(width - chip_margin, y), (width - chip_margin + pin_length, y)], fill='#4fc3f7', width=2)
    
    # Draw small squares inside representing chip internals
    center = width // 2
    square_size = 4
    for dx in [-8, 0, 8]:
        for dy in [-8, 0, 8]:
            x = center + dx
            y = center + dy
            draw.rectangle(
                [x - square_size//2, y - square_size//2, x + square_size//2, y + square_size//2],
                fill='#ffa726'
            )
    
    return image


class SystemTrayApp:
    """System tray application for Papilio Loader."""
    
    def __init__(self, port: int = 8000, on_exit_callback=None):
        """Initialize the system tray app.
        
        Args:
            port: The port number the web server is running on
            on_exit_callback: Optional callback to run when exiting
        """
        self.port = port
        self.on_exit_callback = on_exit_callback
        self.icon = None
        self.running = False
        
    def open_web_interface(self, icon=None, item=None):
        """Open the web interface in the default browser."""
        webbrowser.open(f'http://localhost:{self.port}')
    
    def show_about(self, icon=None, item=None):
        """Show about information (opens GitHub page)."""
        webbrowser.open('https://github.com/Papilio-Labs/papilio-loader')
    
    def stop_server(self, icon=None, item=None):
        """Stop the server and exit the application."""
        logger.info("Stop server requested")
        self.running = False
        if self.on_exit_callback:
            self.on_exit_callback()
        if self.icon:
            self.icon.stop()
    
    def create_menu(self):
        """Create the system tray menu."""
        return pystray.Menu(
            item(
                'Open Web Interface',
                self.open_web_interface,
                default=True
            ),
            item(
                'About',
                self.show_about
            ),
            pystray.Menu.SEPARATOR,
            item(
                'Stop Server and Exit',
                self.stop_server
            )
        )
    
    def setup(self, icon):
        """Setup function called when icon is ready."""
        icon.visible = True
        logger.info("System tray icon setup complete, icon is now visible")
        print("System tray icon is now visible")
    
    def run(self):
        """Run the system tray application.
        
        For Windows frozen executables (especially windowless), we need to ensure
        the icon runs with proper message loop handling.
        """
        import time
        
        self.running = True
        
        logger.info("Creating system tray icon...")
        print("Creating system tray icon...")
        
        # Create the icon
        self.icon = pystray.Icon(
            'papilio-loader',
            create_icon_image(),
            'Papilio Loader',
            menu=self.create_menu()
        )
        
        logger.info("Starting system tray icon...")
        print("Starting system tray icon...")
        
        try:
            # For frozen Windows executables, especially windowless builds,
            # use run_detached() + keep-alive loop to ensure proper operation
            if getattr(sys, 'frozen', False) and sys.platform == 'win32':
                logger.info("Using run_detached() for frozen Windows build")
                
                # Start icon in a separate thread
                self.icon.run_detached(setup=self.setup)
                
                logger.info("Icon started in detached mode, entering keep-alive loop...")
                logger.info(f"Initial self.running state: {self.running}")
                print("System tray is running in background")
                
                # Keep-alive loop - this keeps the main thread alive
                # while the icon runs in its own thread
                # We check self.running which is set to False by stop_server()
                iteration = 0
                while self.running:
                    time.sleep(0.5)
                    iteration += 1
                    if iteration == 1:
                        logger.info(f"Keep-alive loop iteration {iteration}, self.running={self.running}")
                
                logger.info(f"Keep-alive loop exited, self.running={self.running}")
            else:
                # Non-frozen or non-Windows: use blocking run()
                logger.info("Using blocking run() for non-frozen build")
                self.icon.run(setup=self.setup)
            
            logger.info("System tray has shut down normally")
        except Exception as e:
            logger.error(f"System tray failed: {e}", exc_info=True)
            raise
        finally:
            print("System tray has exited")
            self.running = False
    
    def run_in_thread(self):
        """Run the system tray in a separate thread.
        
        Returns:
            The thread object
        """
        thread = threading.Thread(target=self.run, daemon=False)
        thread.start()
        return thread
    
    def notify(self, title: str, message: str):
        """Show a system notification.
        
        Args:
            title: Notification title
            message: Notification message
        """
        if self.icon and self.running:
            self.icon.notify(message, title)


def main():
    """Test the system tray functionality."""
    import time
    
    app = SystemTrayApp(port=8000)
    
    print("Starting system tray...")
    print("The application will run in the system tray.")
    print("Right-click the icon to access the menu.")
    
    # Run in main thread (required for macOS compatibility)
    try:
        app.run()
    except KeyboardInterrupt:
        print("\nShutting down...")
        if app.icon:
            app.icon.stop()


if __name__ == '__main__':
    main()

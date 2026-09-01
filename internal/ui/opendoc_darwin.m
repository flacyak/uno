// Answers the Apple Event Finder sends when it opens a document with uno.
//
// Compiled only into darwin builds, by the constraint on opendoc_darwin.go.
// There is no ARC here: cgo compiles .m files without it, so the one CoreFoundation
// object this creates is released by hand.

#import <Cocoa/Cocoa.h>

#import "_cgo_export.h"

@interface unoOpenDocuments : NSObject
- (void)handleOpenDocuments:(NSAppleEventDescriptor *)event
             withReplyEvent:(NSAppleEventDescriptor *)reply;
@end

@implementation unoOpenDocuments

// send passes one descriptor's path to Go, or does nothing if it does not name
// a file. A dropped item costs that file; it must not cost the rest of the event.
- (void)send:(NSAppleEventDescriptor *)item
{
    NSAppleEventDescriptor *url = [item coerceToDescriptorType:typeFileURL];
    if (url == nil) {
        return;
    }

    NSData *bytes = [url data];
    if (bytes == nil) {
        return;
    }

    // The descriptor carries a URL as bytes rather than as a path, which is what
    // keeps a name with a space or a non-ASCII character intact on the way here.
    CFURLRef ref = CFURLCreateWithBytes(NULL, [bytes bytes], [bytes length],
                                        kCFStringEncodingUTF8, NULL);
    if (ref == NULL) {
        return;
    }

    NSString *path = [(NSURL *)ref path];
    if (path != nil) {
        unoOpenDocument((char *)[path UTF8String]);
    }
    CFRelease(ref);
}

- (void)handleOpenDocuments:(NSAppleEventDescriptor *)event
             withReplyEvent:(NSAppleEventDescriptor *)reply
{
    NSAppleEventDescriptor *direct = [event paramDescriptorForKeyword:keyDirectObject];
    if (direct == nil) {
        return;
    }

    // Opening several files at once is one event carrying a list. Opening one is
    // allowed to arrive as a bare descriptor instead, where numberOfItems is 0.
    NSInteger count = [direct numberOfItems];
    if (count == 0) {
        [self send:direct];
        return;
    }

    for (NSInteger i = 1; i <= count; i++) { // Apple Event lists are 1-based
        [self send:[direct descriptorAtIndex:i]];
    }
}

@end

// The handler is kept alive for the life of the process: the event manager holds
// no reference to it, so letting it go would leave the registration dangling.
static unoOpenDocuments *unoHandler = nil;

void unoInstallOpenDocumentsHandler(void)
{
    if (unoHandler != nil) {
        return; // installing twice would be harmless, but so is not doing it
    }
    unoHandler = [[unoOpenDocuments alloc] init];

    [[NSAppleEventManager sharedAppleEventManager]
        setEventHandler:unoHandler
            andSelector:@selector(handleOpenDocuments:withReplyEvent:)
          forEventClass:kCoreEventClass
             andEventID:kAEOpenDocuments];
}

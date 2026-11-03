import QtQuick 2.12
import Lomiri.Components 1.3
import Lomiri.Components.Popups 1.3
import Lomiri.Content 1.3
import QtWebEngine 1.10
import io.thp.pyotherside 1.5

MainView {
    id: root
    objectName: "mainView"
    applicationName: "assinei-ut.braga"
    automaticOrientation: true

    width: units.gu(45)
    height: units.gu(80)

    property var activeTransfer: null
    property string pendingExportFilePath: ""

    PageStack {
        id: pageStack
        anchors.fill: parent

        Component.onCompleted: {
            pageStack.push(mainPage)
        }

        Page {
            id: mainPage
            anchors.fill: parent
            header: PageHeader {
                id: mainHeader
                visible: false
                title: "Assinei!"
            }

            WebEngineProfile {
                id: assineiProfile
                storageName: "assinei-ut-profile"
                offTheRecord: false
                httpCacheType: WebEngineProfile.NoCache
                persistentCookiesPolicy: WebEngineProfile.ForcePersistentCookies
                httpUserAgent: "Mozilla/5.0 (Linux; Ubuntu Touch) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 AssineiUT/1.0"
            }

            WebEngineView {
                id: webview
                anchors.fill: parent
                profile: assineiProfile
                zoomFactor: Math.max(1.0, units.gu(1) / 8.5)
                settings.localContentCanAccessRemoteUrls: true
                settings.localContentCanAccessFileUrls: true
                settings.javascriptEnabled: true
                settings.localStorageEnabled: true
                settings.accelerated2dCanvasEnabled: true

                onNewViewRequested: function(request) {
                    Qt.openUrlExternally(request.requestedUrl)
                }
            }
        }
    }

    // Seletor do Lomiri Content Hub para IMPORTAR (Abrir) documentos PDF
    Component {
        id: importPickerComponent
        Page {
            id: importPickerPage
            header: PageHeader {
                title: "Escolher Documento PDF"
            }

            ContentPeerPicker {
                anchors {
                    fill: parent
                    topMargin: importPickerPage.header.height
                }
                visible: true
                contentType: ContentType.Documents
                handler: ContentHandler.Source

                onPeerSelected: {
                    peer.selectionType = ContentTransfer.Single
                    var mainRoot = root
                    var transfer = peer.request()
                    mainRoot.activeTransfer = transfer
                    transfer.stateChanged.connect(function() {
                        if (transfer && transfer.state === ContentTransfer.Charged) {
                            mainRoot.handleChargedTransfer(transfer)
                        }
                    })
                    pageStack.pop()
                }

                onCancelPressed: {
                    pageStack.pop()
                }
            }
        }
    }

    // Seletor do Lomiri Content Hub para EXPORTAR (Salvar/Compartilhar) o PDF assinado
    Component {
        id: exportPickerComponent
        Page {
            id: exportPickerPage
            header: PageHeader {
                title: "Salvar ou Compartilhar PDF Assinado"
            }

            ContentPeerPicker {
                anchors {
                    fill: parent
                    topMargin: exportPickerPage.header.height
                }
                visible: true
                contentType: ContentType.Documents
                handler: ContentHandler.Destination

                onPeerSelected: {
                    var transfer = peer.request()
                    if (transfer.state === ContentTransfer.InProgress) {
                        transfer.items = [
                            contentItemComponent.createObject(root, { "url": "file://" + root.pendingExportFilePath })
                        ]
                        transfer.state = ContentTransfer.Charged
                    }
                    pageStack.pop()
                }

                onCancelPressed: {
                    pageStack.pop()
                }
            }
        }
    }

    Component {
        id: contentItemComponent
        ContentItem {}
    }

    function handleChargedTransfer(transfer) {
        if (!transfer || !transfer.items) return
        for (var i = 0; i < transfer.items.length; i++) {
            var fileUrl = transfer.items[i].url.toString()
            python.call("backend.import_file", [fileUrl], function(res) {
                webview.runJavaScript("window.dispatchEvent(new CustomEvent('ut-check-pending-files'));")
            })
        }
        transfer.finalize()
    }

    // Recebe arquivos abertos por outros apps ("Abrir com Assinei!") via Lomiri Content Hub
    Connections {
        target: ContentHub

        onImportRequested: function(transfer) {
            handleChargedTransfer(transfer)
        }

        onShareRequested: function(transfer) {
            handleChargedTransfer(transfer)
        }
    }

    Python {
        id: python

        Component.onCompleted: {
            var rawUrl = Qt.resolvedUrl("../src/ubuntu_touch").toString()
            var srcPath = rawUrl.replace(/^file:\/\//, "")
            addImportPath(srcPath)

            setHandler("request-import-pdf", function(payload) {
                pageStack.push(importPickerComponent)
            })

            setHandler("request-export-pdf", function(filePath) {
                root.pendingExportFilePath = filePath
                pageStack.push(exportPickerComponent)
            })

            setHandler("pdf-imported", function(payload) {
                webview.runJavaScript("window.dispatchEvent(new CustomEvent('ut-check-pending-files'));")
            })

            importModule("backend", function() {
                call("backend.start_server", [], function(serverUrl) {
                    webview.url = serverUrl + "?t=" + Date.now()

                    // Verifica se o app recebeu algum caminho de PDF via argumento (%u)
                    var args = Qt.application.arguments
                    for (var i = 1; i < args.length; i++) {
                        if (args[i].toLowerCase().indexOf(".pdf") !== -1) {
                            call("backend.import_file", [args[i]], function() {
                                webview.runJavaScript("window.dispatchEvent(new CustomEvent('ut-check-pending-files'));")
                            })
                        }
                    }
                })
            })
        }

        onError: function(traceback) {
            console.log("[Assinei-UT PyOtherSide Error]: " + traceback)
        }
    }
}

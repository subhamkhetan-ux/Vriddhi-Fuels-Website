VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "SDict"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = False
Attribute VB_Exposed = False
Option Explicit
'==================================================================
'  SDict  -  Mac-safe stand-in for Scripting.Dictionary
'  Built on a native VBA Collection so it works on Excel for Mac
'  (Scripting.Dictionary is Windows-only and throws Error 429 on Mac).
'  Supports: Add, SetItem, Item, Exists, Keys, Count
'  Keys are compared as text (CStr), so numeric keys work too.
'==================================================================
Private mKeys As Collection   ' ordered list of key strings
Private mVals As Collection   ' values, keyed by CStr(key)

Private Sub Class_Initialize()
    Set mKeys = New Collection
    Set mVals = New Collection
End Sub

Public Function Exists(ByVal key As Variant) As Boolean
    On Error GoTo NoKey
    Dim t As Variant
    If IsObject(mVals.Item(CStr(key))) Then
        Exists = True
    Else
        Exists = True
    End If
    Exit Function
NoKey:
    Exists = False
End Function

' Add a NEW key. If the key already exists, its value is replaced.
Public Sub Add(ByVal key As Variant, ByVal Item As Variant)
    SetItem key, Item
End Sub

' Add or replace a key's value (object or primitive).
Public Sub SetItem(ByVal key As Variant, ByVal Item As Variant)
    If Exists(key) Then
        mVals.Remove CStr(key)
    Else
        mKeys.Add CStr(key)
    End If
    mVals.Add Item, CStr(key)
End Sub

' Read a key. Missing key returns Empty (mimics Scripting.Dictionary).
Public Function Item(ByVal key As Variant) As Variant
    On Error GoTo NoKey
    If IsObject(mVals.Item(CStr(key))) Then
        Set Item = mVals.Item(CStr(key))
    Else
        Item = mVals.Item(CStr(key))
    End If
    Exit Function
NoKey:
    Item = Empty
End Function

Public Function Keys() As Variant
    Dim a() As String, i As Long
    If mKeys.Count = 0 Then
        Keys = Array()
        Exit Function
    End If
    ReDim a(0 To mKeys.Count - 1)
    For i = 1 To mKeys.Count
        a(i - 1) = mKeys.Item(i)
    Next i
    Keys = a
End Function

Public Property Get Count() As Long
    Count = mKeys.Count
End Property
